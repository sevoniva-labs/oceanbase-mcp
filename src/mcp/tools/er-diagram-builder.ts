import {
  loadErMetadataBatch,
  listErForeignKeyRelationshipsBatch,
  listTables,
  type TableRef,
  type TableRelationship
} from "../../db.js";
import { buildErDiagram, type ErDiagram, type ErEntity } from "../../er.js";
import type { ErGraph, ErGraphDiagnostic, ErGraphStatus } from "../../er-graph.js";
import { assertTableAccess, filterColumnMetadata, filterTables } from "../../policy.js";
import { selectRuntimeProfile, withQuerySlot } from "../../runtime.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { erDiagnosticsFromWarnings, formatErColumnLimitWarnings } from "./er-response.js";
import {
  dedupeRelationships,
  erRelationshipKey,
  isErRelationshipVisible,
  parseErInputTableRef,
  tableRefKey
} from "./er-relationships.js";
import {
  addErScopeTable,
  erEntityFromMetadata,
  erScopeTableOutput,
  groupErMetadataRows,
  tableRefFromMetadata,
  uniqueStrings,
  type ErScopeTable
} from "./er-metadata.js";
import {
  findPrepareQueryCandidates,
  prepareQuerySearchTerms
} from "./sql-prepare.js";

export interface BuildErDiagramInput {
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
}

export interface ErDiagramToolResponse {
  mode: "mysql" | "oracle";
  schema?: string;
  rootTable: string | null;
  businessTerm: string | null;
  scope: ReturnType<typeof erScopeTableOutput>[];
  maxTables: number;
  maxRelationships: number;
  depth: number;
  minConfidence: number;
  relationshipMode: "none" | "foreign_key" | "inferred";
  includeInferred: boolean;
  tableCount: number;
  relationshipCount: number;
  discoveredRelationshipCount: number;
  filteredRelationshipCount: number;
  status: ErGraphStatus;
  diagnostics: ErGraphDiagnostic[];
  stats: {
    selectedTables: number;
    loadedTables: number;
    loadedColumns: number;
    relationships: number;
    queryCount: number;
    elapsedMs: number;
    cacheUsed: boolean;
    cacheStats: {
      hits: number;
      misses: number;
      evictions: number;
      entries: number;
    };
    truncated: boolean;
    truncatedTables: number;
    truncatedColumns: number;
    skippedStages: string[];
    warnings: string[];
  };
  mermaid: string;
  diagram: {
    entities: ErEntity[];
    relationships: TableRelationship[];
  };
  graph: ErGraph;
  warnings: string[];
}

export async function buildErDiagramResult(
  selected: ReturnType<typeof selectRuntimeProfile>,
  input: BuildErDiagramInput
): Promise<{ diagram: ErDiagram; response: ErDiagramToolResponse }> {
  const startedAt = Date.now();
  const effectiveSchema = metadataSchema(selected.config, input.schema);
  const configuredMaxTables = Math.max(1, selected.config.erMaxTables);
  const tableLimit = Math.min(input.maxTables ?? (input.table ? Math.min(20, configuredMaxTables) : Math.min(12, configuredMaxTables)), configuredMaxTables, 500);
  const maxRelationships = Math.min(input.maxRelationships ?? selected.config.erMaxRelationships, selected.config.erMaxRelationships, 1000);
  const depthLimit = input.depth ?? 1;
  const relationshipMode = input.includeInferred ? "inferred" : input.relationshipMode ?? "foreign_key";
  const includeInferred = relationshipMode === "inferred";
  const relationConfidenceFloor = input.minConfidence ?? (includeInferred ? 0.5 : 0.9);
  const requestedTables = uniqueStrings([input.table, ...(input.tables ?? [])].filter((value): value is string => Boolean(value)));
  if (requestedTables.length === 0 && !input.businessTerm && !effectiveSchema) {
    throw new Error("Pass schema or table when generating an ER diagram without a configured default schema.");
  }

  const scope = new Map<string, ErScopeTable>();
  const relationships: TableRelationship[] = [];
  const warnings: string[] = [];
  const skippedStages: string[] = [];
  let relationshipScopeLimited = false;
  let queryCount = 0;
  let truncated = false;
  const erTimeoutMs = Math.min(selected.config.erQueryTimeoutMs, selected.config.queryTimeoutMs);
  const timeExpired = () => Date.now() - startedAt >= selected.config.erTotalTimeoutMs;
  const stageQuery = async <T>(operation: () => Promise<T>): Promise<T> => {
    queryCount += 1;
    return withQuerySlot(selected, operation);
  };

  for (const requestedTable of requestedTables) {
    const ref = parseErInputTableRef(selected.config.compatibility, requestedTable, effectiveSchema);
    assertTableAccess(ref.schema, ref.table, policyContext(selected.config));
    addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
      source: requestedTable === input.table ? "explicit_table" : "explicit_tables",
      confidence: 1,
      evidence: [`Requested table ${requestedTable}.`]
    });
  }

  if (input.businessTerm) {
    const candidates = await findPrepareQueryCandidates(
      selected,
      prepareQuerySearchTerms(input.businessTerm, input.businessTerm, undefined),
      effectiveSchema,
      tableLimit,
      warnings
    );
    for (const candidate of candidates) {
      addErScopeTable(scope, selected.config.compatibility, candidate.schema, candidate.table, tableLimit, {
        source: "business_term",
        confidence: candidate.confidence,
        evidence: candidate.evidence.map((item) => `${item.field}: ${item.value} (${item.reason})`).slice(0, 5)
      });
    }
    if (candidates.length === 0) {
      warnings.push("No visible table matched the supplied businessTerm.");
    }
  }

  if (scope.size === 0) {
    const rows = filterTables(
      await stageQuery(() =>
        listTables(
          selected.pool,
          selected.config.compatibility,
          effectiveSchema,
          tableLimit,
          erTimeoutMs
        )
      ),
      selected.config.policy
    );
    for (const row of rows) {
      const ref = tableRefFromMetadata(row, effectiveSchema);
      if (ref) {
        addErScopeTable(scope, selected.config.compatibility, ref.schema, ref.table, tableLimit, {
          source: "schema_scan",
          confidence: 1,
          evidence: ["Returned from visible table metadata."]
        });
      }
    }
  }

  const initialRefs = [...scope.values()];
  let discoveredRelationshipCount = 0;
  let filteredRelationshipCount = 0;
  const relationshipKeys = new Set<string>();
  if (relationshipMode === "none") {
    skippedStages.push("relationships");
    warnings.push("Relationship discovery was skipped because relationshipMode=none.");
  } else {
    let frontier: TableRef[] = initialRefs.map((ref) => ({ schema: ref.schema, table: ref.table }));
    const visitedRelationshipRefs = new Set<string>();
    for (let depth = 1; depth <= depthLimit && frontier.length > 0; depth += 1) {
      if (timeExpired()) {
        truncated = true;
        skippedStages.push("relationships_timeout");
        warnings.push(`ER relationship discovery stopped after OB_ER_TOTAL_TIMEOUT_MS=${selected.config.erTotalTimeoutMs}.`);
        break;
      }
      if (relationships.length >= maxRelationships) {
        truncated = true;
        relationshipScopeLimited = true;
        warnings.push(`Relationship discovery stopped at maxRelationships=${maxRelationships}.`);
        break;
      }
      const batchRefs = frontier.filter((ref) => {
        const key = tableRefKey(selected.config.compatibility, ref.schema, ref.table);
        if (visitedRelationshipRefs.has(key)) {
          return false;
        }
        visitedRelationshipRefs.add(key);
        return true;
      });
      frontier = [];
      if (batchRefs.length === 0) {
        continue;
      }
      const batch = relationshipMode === "foreign_key"
        ? await withQuerySlot(selected, () =>
            listErForeignKeyRelationshipsBatch(
              selected.pool,
              selected.config.compatibility,
              batchRefs,
              erTimeoutMs
            )
          )
        : await withQuerySlot(selected, () =>
            loadErMetadataBatch(selected.pool, selected.config.compatibility, batchRefs, {
              relationshipMode,
              maxRelationships: Math.max(1, maxRelationships - relationships.length),
              maxColumnsPerTable: selected.config.erMaxColumnsPerTable,
              maxIndexRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
              maxConstraintRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
              timeoutMs: erTimeoutMs
            })
          );
      queryCount += batch.queryCount;
      warnings.push(...batch.warnings);
      for (const relation of batch.relationships) {
        discoveredRelationshipCount += 1;
        const scopedRelation = { ...relation, depth };
        if (!isErRelationshipVisible(scopedRelation, selected.config, relationConfidenceFloor, includeInferred)) {
          filteredRelationshipCount += 1;
          continue;
        }
        const key = erRelationshipKey(selected.config.compatibility, scopedRelation);
        if (relationshipKeys.has(key)) {
          continue;
        }
        if (relationships.length >= maxRelationships) {
          truncated = true;
          relationshipScopeLimited = true;
          break;
        }
        relationshipKeys.add(key);
        relationships.push(scopedRelation);
        const evidence = scopedRelation.evidence.map((item) => item.detail).slice(0, 5);
        const sourceKey = tableRefKey(selected.config.compatibility, scopedRelation.sourceSchema, scopedRelation.sourceTable);
        const targetKey = tableRefKey(selected.config.compatibility, scopedRelation.targetSchema, scopedRelation.targetTable);
        const hadSource = scope.has(sourceKey);
        const hadTarget = scope.has(targetKey);
        const addedSource = addErScopeTable(scope, selected.config.compatibility, scopedRelation.sourceSchema, scopedRelation.sourceTable, tableLimit, {
          source: "relationship",
          confidence: scopedRelation.confidence,
          evidence
        });
        const addedTarget = addErScopeTable(scope, selected.config.compatibility, scopedRelation.targetSchema, scopedRelation.targetTable, tableLimit, {
          source: "relationship",
          confidence: scopedRelation.confidence,
          evidence
        });
        if (!addedSource || !addedTarget) {
          relationshipScopeLimited = true;
        }
        if (depth < depthLimit) {
          if (addedSource && !hadSource) {
            frontier.push({ schema: scopedRelation.sourceSchema, table: scopedRelation.sourceTable });
          }
          if (addedTarget && !hadTarget) {
            frontier.push({ schema: scopedRelation.targetSchema, table: scopedRelation.targetTable });
          }
        }
      }
      if (truncated) {
        break;
      }
    }
  }

  const entities: ErEntity[] = [];
  let loadedColumns = 0;
  let truncatedColumns = 0;
  const truncatedColumnTables: string[] = [];
  const finalRefs = [...scope.values()].map((ref) => ({ schema: ref.schema, table: ref.table }));
  let columnsByTable = new Map<string, unknown[]>();
  let constraintsByTable = new Map<string, unknown[]>();
  let indexesByTable = new Map<string, unknown[]>();
  if (finalRefs.length > 0) {
    if (timeExpired()) {
      truncated = true;
      skippedStages.push("entities_timeout");
      warnings.push(`ER table metadata loading stopped after OB_ER_TOTAL_TIMEOUT_MS=${selected.config.erTotalTimeoutMs}.`);
    } else {
      const batch = await withQuerySlot(selected, () =>
        loadErMetadataBatch(selected.pool, selected.config.compatibility, finalRefs, {
          relationshipMode: "none",
          maxRelationships: 1,
          maxColumnsPerTable: selected.config.erMaxColumnsPerTable,
          maxIndexRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
          maxConstraintRowsPerTable: selected.config.erMaxColumnsPerTable * 4,
          timeoutMs: erTimeoutMs
        })
      );
      queryCount += batch.queryCount;
      warnings.push(...batch.warnings);
      if (batch.truncated) {
        truncated = true;
        truncatedColumnTables.push(...batch.truncatedColumnTables);
        truncatedColumns += batch.truncatedColumns;
      }
      columnsByTable = groupErMetadataRows(selected.config.compatibility, filterColumnMetadata(batch.columns, selected.config.policy));
      constraintsByTable = groupErMetadataRows(selected.config.compatibility, filterColumnMetadata(batch.constraints, selected.config.policy));
      indexesByTable = groupErMetadataRows(selected.config.compatibility, filterColumnMetadata(batch.indexes, selected.config.policy));
    }
  }
  for (const ref of scope.values()) {
    const key = tableRefKey(selected.config.compatibility, ref.schema, ref.table);
    const columns = columnsByTable.get(key) ?? [];
    const constraints = constraintsByTable.get(key) ?? [];
    const indexes = indexesByTable.get(key) ?? [];
    loadedColumns += columns.length;
    const visibleColumns = columns.slice(0, selected.config.erMaxColumnsPerTable);
    if (columns.length > visibleColumns.length) {
      truncated = true;
      truncatedColumns += columns.length - visibleColumns.length;
      truncatedColumnTables.push(ref.schema ? `${ref.schema}.${ref.table}` : ref.table);
    }
    entities.push(erEntityFromMetadata(selected.config.compatibility, ref.schema, ref.table, visibleColumns, constraints, indexes));
  }

  const entityKeys = new Set(
    entities.map((entity) => tableRefKey(selected.config.compatibility, entity.schema, entity.table))
  );
  const diagramRelationships = dedupeRelationships(selected.config.compatibility, relationships).filter(
    (relation) =>
      entityKeys.has(tableRefKey(selected.config.compatibility, relation.sourceSchema, relation.sourceTable)) &&
      entityKeys.has(tableRefKey(selected.config.compatibility, relation.targetSchema, relation.targetTable))
  );
  const responseWarnings = uniqueStrings([
    ...warnings,
    ...formatErColumnLimitWarnings(truncatedColumnTables, selected.config.erMaxColumnsPerTable, truncatedColumns),
    ...(relationshipScopeLimited ? ["Some related tables were omitted because maxTables was reached."] : []),
    ...(relationshipMode === "foreign_key" ? ["Name-inferred relationships are disabled by default; pass relationshipMode=inferred for a bounded inferred diagram."] : []),
    ...(filteredRelationshipCount > 0
      ? [`${filteredRelationshipCount} relationship(s) were hidden by policy, minConfidence, or includeInferred.`]
      : [])
  ]);
  const graphDiagnostics = erDiagnosticsFromWarnings(responseWarnings, {
    truncated,
    relationshipScopeLimited,
    filteredRelationshipCount
  });
  const diagram = buildErDiagram(selected.config.compatibility, entities, diagramRelationships, {
    diagnostics: graphDiagnostics
  });
  const response = {
    mode: selected.config.compatibility,
    schema: effectiveSchema,
    rootTable: input.table ?? null,
    businessTerm: input.businessTerm ?? null,
    scope: [...scope.values()].map(erScopeTableOutput),
    maxTables: tableLimit,
    maxRelationships,
    depth: depthLimit,
    minConfidence: relationConfidenceFloor,
    relationshipMode,
    includeInferred,
    tableCount: entities.length,
    relationshipCount: diagramRelationships.length,
    discoveredRelationshipCount,
    filteredRelationshipCount,
    status: diagram.graph.status,
    diagnostics: diagram.graph.diagnostics,
    stats: {
      selectedTables: scope.size,
      loadedTables: entities.length,
      loadedColumns,
      relationships: diagramRelationships.length,
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
      truncatedTables: truncatedColumnTables.length,
      truncatedColumns,
      skippedStages,
      warnings: responseWarnings
    },
    mermaid: diagram.mermaid,
    diagram: {
      entities: diagram.entities,
      relationships: diagram.relationships
    },
    graph: diagram.graph,
    warnings: responseWarnings
  };
  return { diagram, response };
}
