import type { ObConfig } from "../../config.js";
import type { TableRef, TableRelationship } from "../../db.js";
import { normalizeTableName } from "./profile-utils.js";
import { isRelationshipAllowed } from "./schema-map.js";

export function entityRelationshipEvidence(relation: TableRelationship) {
  return {
    relationType: relation.relationType,
    direction: relation.direction,
    confidence: relation.confidence,
    source: {
      schema: relation.sourceSchema,
      table: relation.sourceTable,
      columns: relation.sourceColumns
    },
    target: {
      schema: relation.targetSchema,
      table: relation.targetTable,
      columns: relation.targetColumns
    },
    constraintName: relation.constraintName,
    evidence: relation.evidence.map((item) => ({
      type: item.type,
      detail: item.detail,
      columns: item.columns
    }))
  };
}

export function relationshipConnectsTables(
  mode: ObConfig["compatibility"],
  relation: TableRelationship,
  left: TableRef,
  right: TableRef
): boolean {
  const source = { schema: relation.sourceSchema, table: relation.sourceTable };
  const target = { schema: relation.targetSchema, table: relation.targetTable };
  return (
    sameTableRef(mode, source, left) &&
    sameTableRef(mode, target, right)
  ) || (
    sameTableRef(mode, source, right) &&
    sameTableRef(mode, target, left)
  );
}

export function relationshipPaths(
  mode: ObConfig["compatibility"],
  relations: TableRelationship[],
  source: TableRef,
  target: TableRef,
  maxDepth: number,
  maxPaths: number
): Array<{
  tables: TableRef[];
  relationshipCount: number;
  confidence: number;
  relationships: Array<ReturnType<typeof entityRelationshipEvidence>>;
  evidence: string[];
}> {
  const sourceKey = tableRefKey(mode, source.schema, source.table);
  const targetKey = tableRefKey(mode, target.schema, target.table);
  if (sourceKey === targetKey) {
    return [];
  }

  const adjacency = new Map<string, Array<{ node: TableRef; relation: TableRelationship }>>();
  const addEdge = (
    from: TableRef,
    to: TableRef,
    relation: TableRelationship
  ) => {
    const key = tableRefKey(mode, from.schema, from.table);
    const next = { schema: to.schema, table: to.table };
    adjacency.set(key, [...(adjacency.get(key) ?? []), { node: next, relation }]);
  };

  for (const relation of relations) {
    const relationSource = { schema: relation.sourceSchema, table: relation.sourceTable };
    const relationTarget = { schema: relation.targetSchema, table: relation.targetTable };
    addEdge(relationSource, relationTarget, relation);
    addEdge(relationTarget, relationSource, relation);
  }

  const depthLimit = Math.max(1, Math.min(maxDepth, 3));
  const pathLimit = Math.max(1, maxPaths);
  const paths: Array<{
    tables: TableRef[];
    relationshipCount: number;
    confidence: number;
    relationships: Array<ReturnType<typeof entityRelationshipEvidence>>;
    evidence: string[];
  }> = [];
  const emitted = new Set<string>();
  const queue: Array<{
    key: string;
    tables: TableRef[];
    relations: TableRelationship[];
    visited: Set<string>;
  }> = [{
    key: sourceKey,
    tables: [{ schema: source.schema, table: source.table }],
    relations: [],
    visited: new Set([sourceKey])
  }];

  while (queue.length > 0 && paths.length < pathLimit) {
    const current = queue.shift()!;
    if (current.relations.length >= depthLimit) {
      continue;
    }
    for (const edge of adjacency.get(current.key) ?? []) {
      const nextKey = tableRefKey(mode, edge.node.schema, edge.node.table);
      if (current.visited.has(nextKey)) {
        continue;
      }
      const nextTables = [...current.tables, edge.node];
      const nextRelations = [...current.relations, edge.relation];
      if (nextKey === targetKey) {
        const pathKey = nextTables.map((item) => tableRefKey(mode, item.schema, item.table)).join(">");
        if (!emitted.has(pathKey)) {
          emitted.add(pathKey);
          paths.push({
            tables: nextTables,
            relationshipCount: nextRelations.length,
            confidence: Number(Math.min(...nextRelations.map((relation) => relation.confidence)).toFixed(3)),
            relationships: nextRelations.map(entityRelationshipEvidence),
            evidence: uniqueStrings(
              nextRelations.flatMap((relation) => relation.evidence.map((item) => item.detail))
            ).slice(0, 20)
          });
          if (paths.length >= pathLimit) {
            break;
          }
        }
        continue;
      }
      queue.push({
        key: nextKey,
        tables: nextTables,
        relations: nextRelations,
        visited: new Set([...current.visited, nextKey])
      });
    }
  }

  return paths;
}

export function sameTableRef(
  mode: ObConfig["compatibility"],
  left: TableRef,
  right: TableRef
): boolean {
  return tableRefKey(mode, left.schema, left.table) === tableRefKey(mode, right.schema, right.table);
}

export function parseErInputTableRef(
  mode: ObConfig["compatibility"],
  value: string,
  fallbackSchema: string | undefined
): TableRef {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(".");
  const schema = separator > 0 ? trimmed.slice(0, separator).trim() : fallbackSchema;
  const table = separator > 0 ? trimmed.slice(separator + 1).trim() : trimmed;
  return {
    schema: mode === "oracle" && schema ? schema.toUpperCase() : schema,
    table: mode === "oracle" ? table.toUpperCase() : table
  };
}

export function isErRelationshipVisible(
  relation: TableRelationship,
  config: ObConfig,
  minConfidence: number,
  includeInferred: boolean
): boolean {
  if (!includeInferred && relation.relationType === "name_inference") {
    return false;
  }
  if (relation.confidence < minConfidence) {
    return false;
  }
  return isRelationshipAllowed(relation, config);
}

export function dedupeRelationships(mode: ObConfig["compatibility"], relationships: TableRelationship[]): TableRelationship[] {
  const output: TableRelationship[] = [];
  const keys = new Set<string>();
  for (const relationship of relationships) {
    const key = erRelationshipKey(mode, relationship);
    if (!keys.has(key)) {
      keys.add(key);
      output.push(relationship);
    }
  }
  return output;
}

export function erRelationshipKey(mode: ObConfig["compatibility"], relationship: TableRelationship): string {
  return [
    relationship.relationType,
    tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable),
    relationship.sourceColumns.map((column) => normalizeTableName(mode, column)).join(","),
    tableRefKey(mode, relationship.targetSchema, relationship.targetTable),
    relationship.targetColumns.map((column) => normalizeTableName(mode, column)).join(",")
  ].join(":");
}

export function tableRefKey(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return `${schema ? normalizeTableName(mode, schema) : ""}.${normalizeTableName(mode, table)}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
