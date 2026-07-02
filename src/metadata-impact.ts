import {
  parseMetadataComparisonInput,
  type MetadataSnapshotChange,
  type MetadataSnapshotComparison
} from "./metadata-change.js";
import { parseSqlUsageIndexInput } from "./sql-usage.js";
import type { SqlUsageIndex } from "./sql-scan.js";

export interface AnalyzeChangeSqlImpactInput {
  metadataDiff: MetadataSnapshotComparison | string | Record<string, unknown>;
  sqlIndex: SqlUsageIndex | string | Record<string, unknown>;
  maxResults?: number;
}

export interface AnalyzeMetadataImpactInput {
  metadataDiff: MetadataSnapshotComparison | string | Record<string, unknown>;
  sqlIndex?: SqlUsageIndex | string | Record<string, unknown>;
  businessGlossary?: Record<string, unknown>;
  maxResults?: number;
}

export interface SqlImpactItem {
  change: MetadataSnapshotChange;
  file: string;
  line: number;
  statementType: string;
  sqlSnippet: string;
  matchLevel: "clear" | "possible" | "dynamic_unknown";
  evidence: string[];
  risks: string[];
  dynamicSql: {
    detected: boolean;
    sources: string[];
  };
}

export interface ChangeSqlImpactOutput {
  impactVersion: "1.1";
  summary: {
    impactedSql: number;
    impactedFiles: number;
    clearMatches: number;
    possibleMatches: number;
    dynamicUnknown: number;
  };
  impacts: SqlImpactItem[];
  warnings: string[];
  executed: false;
}

export interface MetadataImpactOutput {
  impactVersion: "1.1";
  summary: {
    changes: number;
    breakingChanges: number;
    impactedTables: number;
    impactedColumns: number;
    impactedSql: number;
    impactedFiles: number;
  };
  impactedTables: Array<{ schema?: string; table: string; evidence: string[] }>;
  impactedColumns: Array<{ schema?: string; table?: string; column: string; evidence: string[] }>;
  sqlImpact?: ChangeSqlImpactOutput;
  relationshipImpact: Array<{ changeType: string; object: string; evidence: string[]; confidence: number }>;
  glossaryHints: Array<{ term: string; target: string; evidence: string[] }>;
  reviewItems: string[];
  warnings: string[];
  executed: false;
}

export function analyzeChangeSqlImpact(input: AnalyzeChangeSqlImpactInput): ChangeSqlImpactOutput {
  const diff = parseMetadataComparisonInput(input.metadataDiff);
  const sqlIndex = parseSqlUsageIndexInput(input.sqlIndex);
  const limit = Math.min(Math.max(input.maxResults ?? 200, 1), 1_000);
  const impacts: SqlImpactItem[] = [];

  for (const change of relevantSqlChanges(diff)) {
    for (const entry of sqlIndex.entries) {
      const match = matchChangeToSql(change, entry);
      if (!match) {
        continue;
      }
      impacts.push({
        change,
        file: entry.file,
        line: entry.line,
        statementType: entry.statementType,
        sqlSnippet: entry.sql,
        matchLevel: match.matchLevel,
        evidence: match.evidence,
        risks: entry.risks,
        dynamicSql: entry.dynamicSql
      });
      if (impacts.length >= limit) {
        break;
      }
    }
    if (impacts.length >= limit) {
      break;
    }
  }

  return {
    impactVersion: "1.1",
    summary: summarizeSqlImpact(impacts),
    impacts,
    warnings: [
      impacts.length >= limit ? `Only the first ${limit} SQL impact records are returned.` : "",
      "SQL impact is based on the supplied static SQL usage index.",
      "Dynamic SQL and SELECT * are marked as possible or unknown impact when exact columns cannot be proven.",
      "No SQL is executed and no project files are modified."
    ].filter(Boolean),
    executed: false
  };
}

export function analyzeMetadataImpact(input: AnalyzeMetadataImpactInput): MetadataImpactOutput {
  const diff = parseMetadataComparisonInput(input.metadataDiff);
  const sqlImpact = input.sqlIndex
    ? analyzeChangeSqlImpact({ metadataDiff: diff, sqlIndex: input.sqlIndex, maxResults: input.maxResults })
    : undefined;
  const changes = flattenChanges(diff);
  const impactedTables = summarizeImpactedTables(changes);
  const impactedColumns = summarizeImpactedColumns(changes);
  const relationshipImpact = diff.changes.relationships.map((change) => ({
    changeType: change.changeType,
    object: change.affectedObject.name ?? "(relationship)",
    evidence: change.evidence,
    confidence: relationshipConfidence(change)
  }));
  const glossaryHints = glossaryImpactHints(input.businessGlossary, changes);
  const reviewItems = [
    ...diff.breakingChanges.map((change) => `Review ${change.category} ${changeObjectLabel(change)}: ${change.evidence.join("; ")}`),
    ...(sqlImpact && sqlImpact.summary.dynamicUnknown > 0 ? ["Review dynamic SQL entries because exact impact cannot be proven from static analysis."] : []),
    ...(sqlImpact && sqlImpact.impacts.some((impact) => impact.risks.includes("select_star")) ? ["Review SELECT * usages against removed or modified columns."] : [])
  ];

  return {
    impactVersion: "1.1",
    summary: {
      changes: changes.length,
      breakingChanges: diff.summary.breakingChanges,
      impactedTables: impactedTables.length,
      impactedColumns: impactedColumns.length,
      impactedSql: sqlImpact?.summary.impactedSql ?? 0,
      impactedFiles: sqlImpact?.summary.impactedFiles ?? 0
    },
    impactedTables,
    impactedColumns,
    sqlImpact,
    relationshipImpact,
    glossaryHints,
    reviewItems,
    warnings: [
      "Impact analysis is evidence-based and limited to the supplied metadata diff, SQL index, relationship changes, and business glossary hints.",
      "Business glossary hints do not grant database access and must be verified against metadata.",
      "No SQL is executed and no files are modified."
    ],
    executed: false
  };
}

function relevantSqlChanges(diff: MetadataSnapshotComparison): MetadataSnapshotChange[] {
  return flattenChanges(diff).filter((change) =>
    ["table", "column", "index", "constraint", "partition"].includes(change.category)
  );
}

function flattenChanges(diff: MetadataSnapshotComparison): MetadataSnapshotChange[] {
  return [
    ...diff.changes.schemas,
    ...diff.changes.tables,
    ...diff.changes.columns,
    ...diff.changes.indexes,
    ...diff.changes.constraints,
    ...diff.changes.partitions,
    ...diff.changes.oracleObjects,
    ...diff.changes.relationships
  ];
}

function matchChangeToSql(
  change: MetadataSnapshotChange,
  entry: SqlUsageIndex["entries"][number]
): { matchLevel: SqlImpactItem["matchLevel"]; evidence: string[] } | undefined {
  const table = change.affectedObject.table;
  const column = change.affectedObject.column;
  const tableMatched = table ? entry.tables.some((item) => tableMatches(change.affectedObject.schema, table, item)) : false;
  const columnMatched = column ? entry.columns.some((item) => normalizeIdentifier(item) === normalizeIdentifier(column)) : false;

  if (column && columnMatched) {
    return {
      matchLevel: entry.dynamicSql.detected ? "dynamic_unknown" : "clear",
      evidence: [`SQL references changed column ${column}.`]
    };
  }
  if (column && tableMatched && entry.risks.includes("select_star")) {
    return {
      matchLevel: "possible",
      evidence: [`SQL references table ${table} with SELECT *; changed column ${column} may be used.`]
    };
  }
  if (column && tableMatched && entry.dynamicSql.detected) {
    return {
      matchLevel: "dynamic_unknown",
      evidence: [`SQL references table ${table} and contains dynamic SQL; changed column ${column} cannot be confirmed statically.`]
    };
  }
  if (tableMatched) {
    return {
      matchLevel: entry.dynamicSql.detected ? "dynamic_unknown" : "clear",
      evidence: [`SQL references changed table ${table}.`]
    };
  }
  return undefined;
}

function summarizeSqlImpact(impacts: SqlImpactItem[]): ChangeSqlImpactOutput["summary"] {
  return {
    impactedSql: impacts.length,
    impactedFiles: new Set(impacts.map((impact) => impact.file)).size,
    clearMatches: impacts.filter((impact) => impact.matchLevel === "clear").length,
    possibleMatches: impacts.filter((impact) => impact.matchLevel === "possible").length,
    dynamicUnknown: impacts.filter((impact) => impact.matchLevel === "dynamic_unknown").length
  };
}

function summarizeImpactedTables(changes: MetadataSnapshotChange[]): MetadataImpactOutput["impactedTables"] {
  const grouped = new Map<string, { schema?: string; table: string; evidence: string[] }>();
  for (const change of changes) {
    const table = change.affectedObject.table;
    if (!table) {
      continue;
    }
    const key = `${normalizeIdentifier(change.affectedObject.schema ?? "")}.${normalizeIdentifier(table)}`;
    const current = grouped.get(key) ?? { schema: change.affectedObject.schema, table, evidence: [] };
    current.evidence.push(...change.evidence);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({ ...item, evidence: uniqueStrings(item.evidence).slice(0, 10) }));
}

function summarizeImpactedColumns(changes: MetadataSnapshotChange[]): MetadataImpactOutput["impactedColumns"] {
  const grouped = new Map<string, { schema?: string; table?: string; column: string; evidence: string[] }>();
  for (const change of changes) {
    const column = change.affectedObject.column;
    if (!column) {
      continue;
    }
    const key = [
      normalizeIdentifier(change.affectedObject.schema ?? ""),
      normalizeIdentifier(change.affectedObject.table ?? ""),
      normalizeIdentifier(column)
    ].join(".");
    const current = grouped.get(key) ?? {
      schema: change.affectedObject.schema,
      table: change.affectedObject.table,
      column,
      evidence: []
    };
    current.evidence.push(...change.evidence);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({ ...item, evidence: uniqueStrings(item.evidence).slice(0, 10) }));
}

function glossaryImpactHints(glossary: Record<string, unknown> | undefined, changes: MetadataSnapshotChange[]) {
  const terms = Array.isArray(glossary?.terms) ? glossary.terms : [];
  const hints: Array<{ term: string; target: string; evidence: string[] }> = [];
  for (const termRecord of terms) {
    if (!termRecord || typeof termRecord !== "object" || Array.isArray(termRecord)) {
      continue;
    }
    const record = termRecord as Record<string, unknown>;
    const term = typeof record.term === "string" ? record.term : undefined;
    const targets = Array.isArray(record.targets) ? record.targets : [];
    if (!term) {
      continue;
    }
    for (const target of targets) {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        continue;
      }
      const targetRecord = target as Record<string, unknown>;
      const targetLabel = [targetRecord.schema, targetRecord.table, targetRecord.column]
        .filter((value) => typeof value === "string" && value.trim())
        .join(".");
      if (!targetLabel) {
        continue;
      }
      const matched = changes.some((change) => changeObjectLabel(change).toLowerCase().includes(targetLabel.toLowerCase()));
      if (matched) {
        hints.push({
          term,
          target: targetLabel,
          evidence: ["Business glossary target matched a changed object."]
        });
      }
    }
  }
  return hints.slice(0, 100);
}

function relationshipConfidence(change: MetadataSnapshotChange): number {
  const relation = (change.before ?? change.after) as { confidence?: unknown };
  return typeof relation.confidence === "number" ? relation.confidence : 0;
}

function changeObjectLabel(change: MetadataSnapshotChange): string {
  const object = change.affectedObject;
  if (object.objectName) {
    return `${object.schema ? `${object.schema}.` : ""}${object.objectName}`;
  }
  if (object.column) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table ?? "*"}.${object.column}`;
  }
  if (object.name) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table ?? "*"}.${object.name}`;
  }
  if (object.table) {
    return `${object.schema ? `${object.schema}.` : ""}${object.table}`;
  }
  return object.schema ?? "(unknown)";
}

function tableMatches(schema: string | undefined, requestedTable: string, indexedTable: string): boolean {
  const indexedParts = indexedTable.split(".").map(normalizeIdentifier).filter(Boolean);
  const indexedTableName = indexedParts[indexedParts.length - 1] ?? "";
  if (indexedTableName !== normalizeIdentifier(requestedTable)) {
    return false;
  }
  if (!schema) {
    return true;
  }
  const indexedSchema = indexedParts.length > 1 ? indexedParts[indexedParts.length - 2] : undefined;
  return !indexedSchema || indexedSchema === normalizeIdentifier(schema);
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/[`"]/g, "").toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
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
