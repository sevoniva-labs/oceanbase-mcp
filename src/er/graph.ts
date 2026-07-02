import { createHash } from "node:crypto";

import type { CompatibilityMode } from "../config.js";
import type { TableRelationship } from "../db.js";
import type { ErColumn, ErEntity } from "./render.js";

export type ErRelationshipClass = "confirmed" | "probable" | "possible";
export type ErGraphStatus = "OK" | "Partial" | "Needs Scope" | "Failed";
export type ErDiagnosticLevel = "note" | "warning" | "error";

export interface ErGraphDiagnostic {
  level: ErDiagnosticLevel;
  code: string;
  message: string;
  action?: string;
  count?: number;
}

export interface ErGraphNode {
  id: string;
  schema?: string;
  table: string;
  qualifiedName: string;
  label: string;
  searchText: string;
  group: string;
  domain: string;
  columns: ErColumn[];
  primaryKeys: string[];
  indexes: Array<{
    name: string;
    columns: string[];
  }>;
  rowEstimate?: {
    value: number;
    exact: false;
    source: string;
  };
  comments: {
    table?: string;
    columns: Array<{
      column: string;
      comment: string;
    }>;
  };
}

export interface ErGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceTable: string;
  targetTable: string;
  sourceSchema?: string;
  targetSchema?: string;
  sourceColumns: string[];
  targetColumns: string[];
  relationType: TableRelationship["relationType"];
  relationClass: ErRelationshipClass;
  confidence: number;
  sourceRule: string;
  visibleByDefault: boolean;
  label: string;
  evidence: TableRelationship["evidence"];
}

export interface ErGraph {
  mode: CompatibilityMode;
  nodes: ErGraphNode[];
  edges: ErGraphEdge[];
  summary: {
    tableCount: number;
    relationshipCount: number;
    confirmedRelationships: number;
    probableRelationships: number;
    possibleRelationships: number;
    visibleRelationships: number;
    hiddenRelationships: number;
  };
  status: ErGraphStatus;
  diagnostics: ErGraphDiagnostic[];
}

export interface BuildErGraphOptions {
  diagnostics?: ErGraphDiagnostic[];
  includePossibleByDefault?: boolean;
}

export function buildErGraph(
  mode: CompatibilityMode,
  entities: ErEntity[],
  relationships: TableRelationship[],
  options: BuildErGraphOptions = {}
): ErGraph {
  const nodes = entities.map((entity) => erGraphNode(mode, entity));
  const nodesByRef = new Map(nodes.map((node) => [tableRefKey(mode, node.schema, node.table), node]));
  const edges = relationships.flatMap((relationship) => {
    const source = nodesByRef.get(tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable));
    const target = nodesByRef.get(tableRefKey(mode, relationship.targetSchema, relationship.targetTable));
    if (!source || !target) {
      return [];
    }
    return [erGraphEdge(mode, source, target, relationship, options.includePossibleByDefault === true)];
  });
  const confirmedRelationships = edges.filter((edge) => edge.relationClass === "confirmed").length;
  const probableRelationships = edges.filter((edge) => edge.relationClass === "probable").length;
  const possibleRelationships = edges.filter((edge) => edge.relationClass === "possible").length;
  const hiddenRelationships = edges.filter((edge) => !edge.visibleByDefault).length;
  const diagnostics = compactDiagnostics([
    ...(options.diagnostics ?? []),
    ...(hiddenRelationships > 0
      ? [{
          level: "note" as const,
          code: "possible_relationships_hidden",
          message: `${hiddenRelationships} possible relationship(s) are hidden by default.`,
          action: "Enable possible relationships only when reviewing low-confidence evidence.",
          count: hiddenRelationships
        }]
      : [])
  ]);
  return {
    mode,
    nodes,
    edges,
    summary: {
      tableCount: nodes.length,
      relationshipCount: edges.length,
      confirmedRelationships,
      probableRelationships,
      possibleRelationships,
      visibleRelationships: edges.length - hiddenRelationships,
      hiddenRelationships
    },
    status: graphStatus(diagnostics),
    diagnostics
  };
}

export function erGraphNodeId(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  return stableGraphId("t", tableRefKey(mode, schema, table));
}

export function erGraphEdgeId(
  mode: CompatibilityMode,
  relationship: Pick<
    TableRelationship,
    "relationType" | "sourceSchema" | "sourceTable" | "sourceColumns" | "targetSchema" | "targetTable" | "targetColumns"
  >
): string {
  return stableGraphId("r", [
    relationship.relationType,
    tableRefKey(mode, relationship.sourceSchema, relationship.sourceTable),
    relationship.sourceColumns.map((column) => normalizeRefPart(mode, column)).join(","),
    tableRefKey(mode, relationship.targetSchema, relationship.targetTable),
    relationship.targetColumns.map((column) => normalizeRefPart(mode, column)).join(",")
  ].join("|"));
}

export function classifyErRelationship(relationship: TableRelationship): ErRelationshipClass {
  if (relationship.relationType === "foreign_key" || relationship.relationType === "referenced_by") {
    return "confirmed";
  }
  return relationship.confidence >= 0.65 ? "probable" : "possible";
}

export function tableRefKey(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  return `${schema ? normalizeRefPart(mode, schema) : ""}.${normalizeRefPart(mode, table)}`;
}

function erGraphNode(mode: CompatibilityMode, entity: ErEntity): ErGraphNode {
  const qualifiedName = tableLabel(entity.schema, entity.table);
  const primaryKeys = entity.columns.filter((column) => column.primaryKey).map((column) => column.name);
  return {
    id: erGraphNodeId(mode, entity.schema, entity.table),
    schema: entity.schema,
    table: entity.table,
    qualifiedName,
    label: qualifiedName,
    searchText: [
      qualifiedName,
      entity.schema,
      entity.table,
      ...entity.columns.flatMap((column) => [column.name, column.type, column.comment])
    ].filter(Boolean).join(" ").toLowerCase(),
    group: entity.schema ?? "default",
    domain: inferDomain(entity.table),
    columns: entity.columns,
    primaryKeys,
    indexes: indexesFromColumns(entity.columns),
    rowEstimate: entity.rowEstimate,
    comments: {
      table: entity.comment,
      columns: entity.columns
        .filter((column) => column.comment)
        .map((column) => ({ column: column.name, comment: column.comment! }))
    }
  };
}

function erGraphEdge(
  mode: CompatibilityMode,
  source: ErGraphNode,
  target: ErGraphNode,
  relationship: TableRelationship,
  includePossibleByDefault: boolean
): ErGraphEdge {
  const relationClass = classifyErRelationship(relationship);
  const sourceRule = relationship.evidence[0]?.type ?? relationship.relationType;
  return {
    id: erGraphEdgeId(mode, relationship),
    source: source.id,
    target: target.id,
    sourceTable: relationship.sourceTable,
    targetTable: relationship.targetTable,
    sourceSchema: relationship.sourceSchema,
    targetSchema: relationship.targetSchema,
    sourceColumns: relationship.sourceColumns,
    targetColumns: relationship.targetColumns,
    relationType: relationship.relationType,
    relationClass,
    confidence: Number(relationship.confidence.toFixed(3)),
    sourceRule,
    visibleByDefault: relationClass !== "possible" || includePossibleByDefault,
    label: relationship.constraintName ?? relationship.relationType,
    evidence: relationship.evidence
  };
}

function indexesFromColumns(columns: ErColumn[]): Array<{ name: string; columns: string[] }> {
  const indexes = new Map<string, string[]>();
  for (const column of columns) {
    for (const indexName of column.indexNames ?? []) {
      indexes.set(indexName, [...(indexes.get(indexName) ?? []), column.name]);
    }
  }
  return [...indexes.entries()].map(([name, indexedColumns]) => ({ name, columns: indexedColumns }));
}

function compactDiagnostics(diagnostics: ErGraphDiagnostic[]): ErGraphDiagnostic[] {
  const byCode = new Map<string, ErGraphDiagnostic>();
  for (const diagnostic of diagnostics) {
    const existing = byCode.get(diagnostic.code);
    if (!existing) {
      byCode.set(diagnostic.code, diagnostic);
      continue;
    }
    byCode.set(diagnostic.code, {
      ...existing,
      count: (existing.count ?? 1) + (diagnostic.count ?? 1)
    });
  }
  return [...byCode.values()];
}

function graphStatus(diagnostics: ErGraphDiagnostic[]): ErGraphStatus {
  if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
    return "Failed";
  }
  if (diagnostics.some((diagnostic) => diagnostic.code.includes("scope"))) {
    return "Needs Scope";
  }
  if (diagnostics.some((diagnostic) => diagnostic.level === "warning")) {
    return "Partial";
  }
  return "OK";
}

function inferDomain(table: string): string {
  const normalized = table.trim();
  const underscore = normalized.indexOf("_");
  if (underscore > 0) {
    return normalized.slice(0, underscore);
  }
  const ascii = normalized.match(/^[A-Za-z][A-Za-z0-9]*/);
  if (ascii) {
    return ascii[0].toLowerCase();
  }
  return normalized.slice(0, Math.min(normalized.length, 12)) || "default";
}

function stableGraphId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 14)}`;
}

function tableLabel(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

function normalizeRefPart(mode: CompatibilityMode, value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}
