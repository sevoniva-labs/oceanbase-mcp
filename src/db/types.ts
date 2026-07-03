import type { FieldPacket, QueryResult } from "mysql2/promise";

import type { CompatibilityMode } from "../config.js";

export type SqlParam = string | number | boolean | null;

export interface QueryOptions {
  sql: string;
  values?: SqlParam[];
  timeout?: number;
}

export interface ObPool {
  query(options: string | QueryOptions): Promise<[QueryResult, FieldPacket[]]>;
  getConnection(): Promise<ObConnection>;
  end(): Promise<void>;
}

export interface ObConnection {
  query(options: string | QueryOptions): Promise<[QueryResult, FieldPacket[]]>;
  release(): void;
}

export interface PermissionVerification {
  ok: boolean;
  severity: "pass" | "warn" | "fail";
  mode: CompatibilityMode;
  checked: string[];
  message: string;
  grants?: string[];
  privileges?: string[];
  writablePrivileges: string[];
  error?: string;
}

export interface TableDdlMetadata {
  mode: CompatibilityMode;
  schema?: string;
  table: string;
  nativeDdl?: string;
  structuredDdl: string;
  columns: unknown[];
  columnsTruncated?: boolean;
  indexes: unknown[];
  indexesTruncated?: boolean;
  constraints: unknown[];
  constraintsTruncated?: boolean;
  partitions: unknown[];
  partitionsTruncated?: boolean;
  warnings: string[];
}

export interface TableRelationshipEvidence {
  type: "foreign_key" | "referenced_by" | "naming" | "index" | "primary_or_unique_key";
  detail: string;
  columns?: string[];
}

export interface TableRelationship {
  relationType: "foreign_key" | "referenced_by" | "name_inference";
  direction: "outbound" | "inbound";
  confidence: number;
  sourceSchema?: string;
  sourceTable: string;
  sourceColumns: string[];
  targetSchema?: string;
  targetTable: string;
  targetColumns: string[];
  constraintName?: string;
  depth: number;
  evidence: TableRelationshipEvidence[];
}

export interface TableRef {
  schema?: string;
  table: string;
}

export interface ErExportPlanStats {
  schema?: string;
  estimatedTableCount: number;
  estimatedColumnCount: number;
  estimatedRelationshipCount: number;
  largeTables: Array<{
    schema?: string;
    table: string;
    estimatedRows: number | null;
    estimated: boolean;
  }>;
  queryCount: number;
  warnings: string[];
}

export interface RelatedTablesResult {
  mode: CompatibilityMode;
  root: {
    schema?: string;
    table: string;
  };
  depth: number;
  truncated: boolean;
  relations: TableRelationship[];
}

export interface ErMetadataBatch {
  columns: unknown[];
  indexes: unknown[];
  constraints: unknown[];
  relationships: TableRelationship[];
  queryCount: number;
  truncated: boolean;
  truncatedColumnTables: string[];
  truncatedColumns: number;
  warnings: string[];
}

export interface TableStats {
  mode: CompatibilityMode;
  schema?: string;
  table: string;
  rowEstimate?: {
    value: number;
    exact: false;
    source: string;
  };
  counts: {
    columns: number;
    indexes: number;
    constraints: number;
    partitions: number;
  };
  storage?: {
    dataBytes?: number;
    indexBytes?: number;
    blocks?: number;
  };
  analyzedAt?: string;
  warnings: string[];
}

export interface SchemaMapTable {
  schema?: string;
  table: string;
  tableType?: string;
  engine?: string;
  comment?: string;
  rowEstimate?: {
    value: number;
    exact: false;
    source: string;
  };
}

export interface ColumnSearchFilter {
  query?: string;
  schema?: string;
  tablePattern?: string;
  dataType?: string;
}

export interface ColumnProfileRequest {
  name: string;
  dataType?: string;
}

export interface ColumnProfileValueCount {
  value: unknown;
  count: number;
  ratio: number;
}

export interface ColumnProfile {
  column: string;
  sampledRows: number;
  rowLimit: number;
  nulls: {
    count: number;
    ratio: number;
    exact: false;
    source: string;
  };
  distinct?: {
    value: number;
    exact: false;
    source: string;
  };
  min?: unknown;
  max?: unknown;
  timeRange?: {
    min?: unknown;
    max?: unknown;
  };
  topValues: ColumnProfileValueCount[];
  sampleValues: unknown[];
  warnings: string[];
}

export interface ColumnProfileResult {
  mode: CompatibilityMode;
  schema?: string;
  table: string;
  rowLimit: number;
  topLimit: number;
  sampleValueLimit: number;
  columns: ColumnProfile[];
  warnings: string[];
}

export type OracleObjectType = "VIEW" | "SEQUENCE" | "SYNONYM" | "PROCEDURE" | "FUNCTION" | "PACKAGE" | "PACKAGE BODY";

export interface ObjectListResult {
  mode: CompatibilityMode;
  schema?: string;
  objectTypes: OracleObjectType[];
  objects: unknown[];
  warnings: string[];
}

export interface ObjectSourcePreview {
  lines: Array<{ line: number; text: string }>;
  text: string;
  returnedLines: number;
  truncated: boolean;
  maxLines: number;
  maxChars: number;
}

export interface ObjectMetadataResult {
  mode: CompatibilityMode;
  schema?: string;
  objectName: string;
  objectType: OracleObjectType;
  summary?: Record<string, unknown>;
  details?: Record<string, unknown>;
  columns?: unknown[];
  arguments?: unknown[];
  sourcePreview?: ObjectSourcePreview;
  warnings: string[];
}
