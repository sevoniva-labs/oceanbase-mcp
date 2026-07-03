import {
  estimateErExportPlanStats,
  listErForeignKeyRelationshipsBatch,
  listTables,
  type TableRelationship
} from "../../db.js";
import { assertTableAccess, filterTables } from "../../policy.js";
import { selectRuntimeProfile, withQuerySlot } from "../../runtime.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  buildErExportCommand
} from "./er-response.js";
import {
  dedupeRelationships,
  parseErInputTableRef
} from "./er-relationships.js";
import {
  planErExportChunks,
  planErExportRelationships,
  suggestErExportStrategy,
  tableLabelForCommand,
  type ErExportStrategy
} from "./er-export-plan.js";
import {
  addErScopeTable,
  tableRefFromMetadata,
  uniqueStrings,
  type ErScopeTable
} from "./er-metadata.js";
import { isRelationshipAllowed } from "./schema-map.js";
import {
  findPrepareQueryCandidates,
  prepareQuerySearchTerms
} from "./sql-prepare.js";

export interface BuildErExportPlanInput {
  schema?: string;
  table?: string;
  tables?: string[];
  businessTerm?: string;
  depth?: number;
  maxTables?: number;
  maxRelationships?: number;
  minConfidence?: number;
  relationshipMode?: "none" | "foreign_key" | "inferred";
  includeInferred: boolean;
  format: "html-static" | "html-interactive" | "html-compact" | "html-detailed";
  chunkSize?: number;
  outputDir?: string;
  strategy?: ErExportStrategy;
  maxColumnsPerTable?: number;
}

export async function buildErExportPlanResult(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: BuildErExportPlanInput
) {
  const startedAt = Date.now();
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  const configuredMaxTables = Math.max(1, selected.config.erMaxTables);
  const tableLimit = Math.min(input.maxTables ?? configuredMaxTables, configuredMaxTables, 500);
  const maxRelationships = Math.min(input.maxRelationships ?? selected.config.erMaxRelationships, selected.config.erMaxRelationships, 1000);
  const relationshipMode = input.includeInferred ? "inferred" : input.relationshipMode ?? "foreign_key";
  const includeInferred = relationshipMode === "inferred";
  const erTimeoutMs = Math.min(selected.config.erQueryTimeoutMs, selected.config.queryTimeoutMs);
  const warnings: string[] = [];
  const risks: string[] = [];
  const skippedStages: string[] = [];
  let queryCount = 0;
  let truncated = false;

  if (!input.table && (!input.tables || input.tables.length === 0) && !input.businessTerm && !effectiveSchema) {
    throw new Error("Pass schema, table, tables, or businessTerm when planning an ER export.");
  }

  const planStats = effectiveSchema
    ? await withQuerySlot(selected, async () => {
        const stats = await estimateErExportPlanStats(selected.pool, selected.config.compatibility, effectiveSchema, erTimeoutMs);
        queryCount += stats.queryCount;
        return stats;
      })
    : {
        schema: effectiveSchema,
        estimatedTableCount: 0,
        estimatedColumnCount: 0,
        estimatedRelationshipCount: 0,
        largeTables: [],
        queryCount: 0,
        warnings: ["Schema-level estimates are unavailable because no schema was resolved."]
      };
  warnings.push(...planStats.warnings);

  const scope = new Map<string, ErScopeTable>();
  const requestedTables = uniqueStrings([input.table, ...(input.tables ?? [])].filter((value): value is string => Boolean(value)));
  for (const requestedTable of requestedTables) {
    const ref = parseErInputTableRef(selected.config.compatibility, requestedTable, effectiveSchema);
    assertTableAccess(ref.schema, ref.table, policyContext(selected.config));
    addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
      source: requestedTable === input.table ? "explicit_table" : "explicit_tables",
      confidence: 1,
      evidence: [`Requested table ${requestedTable}.`]
    });
  }

  if (input.businessTerm && scope.size < tableLimit) {
    const candidates = await findPrepareQueryCandidates(
      selected,
      prepareQuerySearchTerms(input.businessTerm, input.businessTerm, undefined),
      effectiveSchema,
      tableLimit - scope.size,
      warnings
    );
    for (const candidate of candidates) {
      addErScopeTable(scope, selected.config.compatibility, candidate.schema, candidate.table, tableLimit, {
        source: "business_term",
        confidence: candidate.confidence,
        evidence: candidate.evidence.map((item) => `${item.field}: ${item.value} (${item.reason})`).slice(0, 5)
      });
    }
    if (candidates.length === 0 && requestedTables.length === 0) {
      warnings.push("No visible table matched the supplied businessTerm.");
    }
  }

  if (scope.size === 0) {
    const rows = filterTables(
      await withQuerySlot(selected, () =>
        listTables(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          tableLimit + 1,
          erTimeoutMs
        )
      ),
      selected.config.policy
    );
    queryCount += 1;
    for (const row of rows.slice(0, tableLimit)) {
      const ref = tableRefFromMetadata(row, effectiveSchema);
      if (ref) {
        addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
          source: "schema_scan",
          confidence: 1,
          evidence: ["Returned from visible table metadata."]
        });
      }
    }
    if (rows.length > tableLimit || planStats.estimatedTableCount > tableLimit) {
      truncated = true;
      warnings.push(`ER export plan selected ${scope.size} table(s); schema estimate is ${planStats.estimatedTableCount}. Use --max-tables or a narrower scope for more tables.`);
    }
  }

  const refs = [...scope.values()].map((ref) => ({ schema: ref.schema, table: ref.table }));
  let relationships: TableRelationship[] = [];
  if (relationshipMode === "none") {
    skippedStages.push("relationships");
    warnings.push("Relationship discovery was skipped because relationshipMode=none.");
  } else if (refs.length > 0) {
    const batch = await withQuerySlot(selected, () =>
      listErForeignKeyRelationshipsBatch(
        selected.pool,
        selected.config.compatibility,
        refs,
        erTimeoutMs
      )
    );
    queryCount += batch.queryCount;
    warnings.push(...batch.warnings);
    relationships = dedupeRelationships(selected.config.compatibility, batch.relationships)
      .filter((relation) => isRelationshipAllowed(relation, selected.config));
    if (relationships.length > maxRelationships) {
      truncated = true;
      relationships = relationships.slice(0, maxRelationships);
      warnings.push(`Relationship planning stopped at maxRelationships=${maxRelationships}.`);
    }
    if (relationshipMode === "inferred") {
      warnings.push("Plan mode does not expand inferred relationships. Generate inferred ER only for a small explicit scope.");
    }
  }

  const strategy = input.strategy ?? suggestErExportStrategy({
    tableCount: refs.length,
    estimatedTableCount: planStats.estimatedTableCount,
    relationshipCount: relationships.length,
    businessTerm: input.businessTerm,
    explicitTables: requestedTables.length
  });
  const chunkSize = Math.max(1, Math.min(input.chunkSize ?? Math.min(25, selected.config.erMaxTables), selected.config.erMaxTables, 100));
  const chunks = planErExportChunks(selected.config.compatibility, refs, relationships, strategy, chunkSize);
  const outputDir = input.outputDir?.replace(/\/+$/g, "");
  const commandBase = {
    schema: planStats.schema ?? effectiveSchema,
    rootTable: input.table ?? null,
    businessTerm: input.businessTerm ?? null,
    relationshipMode,
    maxTables: tableLimit,
    maxRelationships
  };
  const maxColumnsPerTable = input.maxColumnsPerTable ?? selected.config.erMaxColumnsPerTable;
  const plannedChunks = chunks.map((chunk, index) => {
    const file = outputDir
      ? `${outputDir}/clusters/cluster-${String(index + 1).padStart(3, "0")}.html`
      : `cluster-${String(index + 1).padStart(3, "0")}.html`;
    const tableNames = chunk.map((item) => tableLabelForCommand(item.schema, item.table));
    return {
      index: index + 1,
      tableCount: chunk.length,
      tables: tableNames,
      file,
      command: buildErExportCommand(commandBase, input.format, {
        tables: tableNames,
        output: file,
        maxTables: chunk.length,
        maxColumnsPerTable
      })
    };
  });
  const plannedRelationships = planErExportRelationships(selected.config.compatibility, relationships, chunks);

  if (planStats.estimatedTableCount > chunkSize) {
    risks.push("Schema is larger than one ER cluster; use cluster export instead of inline ER.");
  }
  if (planStats.estimatedColumnCount > planStats.estimatedTableCount * Math.max(1, selected.config.erMaxColumnsPerTable)) {
    risks.push("Column count is high; keep main diagrams compact and open table pages for details.");
  }
  if (relationshipMode === "inferred") {
    risks.push("Inferred relationships are naming-based hints, not database constraints.");
  }

  return {
    mode: selected.config.compatibility,
    schema: planStats.schema ?? effectiveSchema,
    rootTable: input.table ?? null,
    businessTerm: input.businessTerm ?? null,
    strategy,
    suggestedStrategy: strategy,
    suggestedMaxTablesPerFile: chunkSize,
    suggestedRelationshipMode: relationshipMode === "inferred" ? "foreign_key" : relationshipMode,
    estimatedTableCount: planStats.estimatedTableCount || refs.length,
    estimatedColumnCount: planStats.estimatedColumnCount,
    estimatedRelationshipCount: planStats.estimatedRelationshipCount || relationships.length,
    largeTables: planStats.largeTables,
    risks,
    recommendedNextTools: [
      "ob_plan_er_export",
      "ob-mcp export-er --out-dir",
      "ob_generate_er_html for small explicit table scopes",
      "ob_find_related_tables for relationship evidence"
    ],
    format: input.format,
    tableCount: refs.length,
    relationshipCount: relationships.length,
    crossClusterRelationshipCount: plannedRelationships.filter((relationship) => relationship.crossCluster).length,
    chunkSize,
    chunkCount: plannedChunks.length,
    inlineHtmlLimitBytes: selected.config.erInlineHtmlMaxBytes,
    singleFileCommand: buildErExportCommand(commandBase, input.format, { maxColumnsPerTable }),
    chunks: plannedChunks,
    relationships: plannedRelationships,
    stats: {
      selectedTables: refs.length,
      loadedTables: refs.length,
      loadedColumns: 0,
      relationships: relationships.length,
      queryCount,
      elapsedMs: Date.now() - startedAt,
      cacheUsed: selected.config.metadataCacheEnabled,
      cacheStats: {
        hits: selected.metadataCache.hits,
        misses: selected.metadataCache.misses,
        evictions: selected.metadataCache.evictions,
        entries: selected.metadataCache.entries.size
      },
      truncated,
      skippedStages,
      warnings
    },
    warnings: uniqueStrings([
      ...warnings,
      ...(plannedChunks.length > 1
        ? ["Use cluster export commands for large schemas to avoid inline MCP response limits and browser rendering pressure."]
        : ["The scope fits in one planned export cluster."]),
      ...(includeInferred ? ["Use relationshipMode=inferred only for small explicit scopes."] : [])
    ])
  };
}
