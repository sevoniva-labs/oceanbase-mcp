import type { ObConfig } from "../../config.js";
import type { TableRef, TableRelationship } from "../../db.js";

export type ErExportStrategy = "single" | "connected-components" | "table-prefix" | "business-term" | "manual" | "window";

export function planErExportRelationships(
  mode: ObConfig["compatibility"],
  relationships: TableRelationship[],
  chunks: TableRef[][]
) {
  const clusterByTable = new Map<string, number>();
  chunks.forEach((chunk, index) => {
    for (const ref of chunk) {
      clusterByTable.set(tableRefKey(mode, ref.schema, ref.table), index + 1);
    }
  });
  return relationships.map((relationship, index) => {
    const sourceKey = tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable);
    const targetKey = tableRefKey(mode, relationship.targetSchema, relationship.targetTable);
    const sourceCluster = clusterByTable.get(sourceKey);
    const targetCluster = clusterByTable.get(targetKey);
    return {
      index: index + 1,
      relationType: relationship.relationType,
      direction: relationship.direction,
      confidence: Number(relationship.confidence.toFixed(3)),
      sourceRule: relationship.evidence[0]?.type ?? relationship.relationType,
      source: {
        schema: relationship.sourceSchema,
        table: relationship.sourceTable,
        label: tableLabelForCommand(relationship.sourceSchema, relationship.sourceTable),
        columns: relationship.sourceColumns,
        cluster: sourceCluster
      },
      target: {
        schema: relationship.targetSchema,
        table: relationship.targetTable,
        label: tableLabelForCommand(relationship.targetSchema, relationship.targetTable),
        columns: relationship.targetColumns,
        cluster: targetCluster
      },
      constraintName: relationship.constraintName,
      evidence: relationship.evidence.map((item) => ({
        type: item.type,
        detail: item.detail,
        columns: item.columns
      })).slice(0, 10),
      crossCluster: Boolean(sourceCluster && targetCluster && sourceCluster !== targetCluster)
    };
  });
}

export function suggestErExportStrategy(input: {
  tableCount: number;
  estimatedTableCount: number;
  relationshipCount: number;
  businessTerm?: string;
  explicitTables: number;
}): ErExportStrategy {
  if (input.explicitTables > 0) {
    return "manual";
  }
  if (input.businessTerm) {
    return "business-term";
  }
  if (input.estimatedTableCount <= 25 && input.tableCount <= 25) {
    return "single";
  }
  if (input.relationshipCount > 0) {
    return "connected-components";
  }
  return "table-prefix";
}

export function planErExportChunks(
  mode: ObConfig["compatibility"],
  refs: TableRef[],
  relationships: TableRelationship[],
  strategy: ErExportStrategy,
  chunkSize: number
): TableRef[][] {
  const sortedRefs = [...refs].sort((left, right) =>
    tableLabelForCommand(left.schema, left.table).localeCompare(tableLabelForCommand(right.schema, right.table))
  );
  if (strategy === "connected-components" && relationships.length > 0) {
    return packChunkGroups(connectedComponentChunks(mode, sortedRefs, relationships), chunkSize);
  }
  if (strategy === "table-prefix") {
    return packChunkGroups(prefixChunks(sortedRefs), chunkSize);
  }
  return chunkItems(sortedRefs, chunkSize);
}

export function tableLabelForCommand(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

function packChunkGroups(groups: TableRef[][], chunkSize: number): TableRef[][] {
  const chunks: TableRef[][] = [];
  let current: TableRef[] = [];
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  };
  for (const group of groups) {
    for (const part of chunkItems(group, chunkSize)) {
      if (part.length >= chunkSize) {
        flush();
        chunks.push(part);
        continue;
      }
      if (current.length + part.length > chunkSize) {
        flush();
      }
      current.push(...part);
    }
  }
  flush();
  return chunks;
}

function prefixChunks(refs: TableRef[]): TableRef[][] {
  const groups = new Map<string, TableRef[]>();
  for (const ref of refs) {
    const prefix = tablePrefix(ref.table);
    groups.set(prefix, [...(groups.get(prefix) ?? []), ref]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => group);
}

function connectedComponentChunks(
  mode: ObConfig["compatibility"],
  refs: TableRef[],
  relationships: TableRelationship[]
): TableRef[][] {
  const refsByKey = new Map(refs.map((ref) => [tableRefKey(mode, ref.schema, ref.table), ref]));
  const parent = new Map([...refsByKey.keys()].map((key) => [key, key]));
  const find = (key: string): string => {
    const current = parent.get(key) ?? key;
    if (current === key) {
      return current;
    }
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };
  for (const relation of relationships) {
    const sourceKey = tableRefKey(mode, relation.sourceSchema, relation.sourceTable);
    const targetKey = tableRefKey(mode, relation.targetSchema, relation.targetTable);
    if (refsByKey.has(sourceKey) && refsByKey.has(targetKey)) {
      union(sourceKey, targetKey);
    }
  }
  const groups = new Map<string, TableRef[]>();
  for (const [key, ref] of refsByKey.entries()) {
    const root = find(key);
    groups.set(root, [...(groups.get(root) ?? []), ref]);
  }
  return [...groups.values()].sort((left, right) => right.length - left.length);
}

function tablePrefix(table: string): string {
  const normalized = table.trim();
  const underscore = normalized.indexOf("_");
  if (underscore > 0) {
    return normalized.slice(0, underscore).toLowerCase();
  }
  const match = normalized.match(/^[A-Za-z]+/);
  return (match?.[0] ?? normalized).toLowerCase();
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function tableRefKey(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return `${normalizeTableName(mode, schema ?? "")}.${normalizeTableName(mode, table)}`;
}

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.toUpperCase() : value.toLowerCase();
}
