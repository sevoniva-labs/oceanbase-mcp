import mysql, { type FieldPacket, type QueryResult } from "mysql2/promise";

import type { CompatibilityMode, ObConfig } from "./config.js";
import { rowsToOutput, type QueryOutput } from "./format.js";

export type SqlParam = string | number | boolean | null;

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
  indexes: unknown[];
  constraints: unknown[];
  partitions: unknown[];
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

interface QueryOptions {
  sql: string;
  values?: SqlParam[];
  timeout?: number;
}

export function createObPool(config: ObConfig): ObPool {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    connectTimeout: config.connectTimeoutMs,
    multipleStatements: false,
    namedPlaceholders: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: "Z",
    ssl: config.ssl
  }) as ObPool;
}

export async function ping(pool: ObPool, config: ObConfig): Promise<Record<string, unknown>> {
  const sql = config.compatibility === "oracle" ? `SELECT ${oracleTimeoutHint(config.queryTimeoutMs)} 1 AS ok FROM DUAL` : "SELECT 1 AS ok";
  const [rows] = await pool.query({ sql, timeout: config.queryTimeoutMs });
  const versionSql =
    config.compatibility === "oracle"
      ? `SELECT ${oracleTimeoutHint(config.queryTimeoutMs)} banner AS version_text FROM v$version WHERE ROWNUM = 1`
      : "SELECT VERSION() AS version_text";
  const [versionRows] = await pool.query({ sql: versionSql, timeout: config.queryTimeoutMs });

  return {
    ok: true,
    ping: rows,
    version: versionRows,
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database ?? null,
    compatibility: config.compatibility
  };
}

export async function runQuery(
  pool: ObPool,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  timeoutMs: number
): Promise<QueryOutput> {
  const [result, fields] = await pool.query({ sql, values: params, timeout: timeoutMs });
  return rowsToOutput(result as QueryResult, fields as FieldPacket[] | undefined, maxRows);
}

export async function runReadOnlyQuery(
  pool: ObPool,
  mode: CompatibilityMode,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  timeoutMs: number,
  enforceReadOnlyTransaction: boolean
): Promise<QueryOutput> {
  if (!enforceReadOnlyTransaction) {
    return runQuery(pool, sql, params, maxRows, timeoutMs);
  }

  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await setOceanBaseQueryTimeout(connection, timeoutMs);
    const readOnlySql = mode === "oracle" ? "SET TRANSACTION READ ONLY" : "START TRANSACTION READ ONLY";
    await connection.query({ sql: readOnlySql, timeout: timeoutMs });
    transactionStarted = true;
    const [result, fields] = await connection.query({ sql, values: params, timeout: timeoutMs });
    await connection.query({ sql: "ROLLBACK", timeout: timeoutMs });
    transactionStarted = false;
    return rowsToOutput(result as QueryResult, fields as FieldPacket[] | undefined, maxRows);
  } finally {
    if (transactionStarted) {
      try {
        await connection.query({ sql: "ROLLBACK", timeout: timeoutMs });
      } catch {
        // The original query error is more useful than a rollback failure here.
      }
    }
    connection.release();
  }
}

async function setOceanBaseQueryTimeout(connection: ObConnection, timeoutMs: number): Promise<void> {
  try {
    await connection.query({
      sql: `SET ob_query_timeout = ${timeoutMicros(timeoutMs)}`,
      timeout: timeoutMs
    });
  } catch {
    // Older or non-OceanBase endpoints may not support this variable.
  }
}

export async function listSchemas(pool: ObPool, mode: CompatibilityMode, timeoutMs: number): Promise<unknown[]> {
  if (mode === "oracle") {
    const [rows] = await pool.query({
      sql: `SELECT ${oracleTimeoutHint(timeoutMs)} username AS schema_name FROM all_users ORDER BY username`,
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const [rows] = await pool.query({ sql: "SHOW DATABASES", timeout: timeoutMs });
  return rows as unknown[];
}

export async function listTables(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string | undefined,
  limit: number,
  timeoutMs: number
): Promise<unknown[]> {
  if (mode === "oracle") {
    const owner = schema?.trim().toUpperCase();
    if (owner) {
      const [rows] = await pool.query({
        sql: `
          SELECT ${oracleTimeoutHint(timeoutMs)} *
          FROM (
            SELECT owner, table_name, tablespace_name, num_rows
            FROM all_tables
            WHERE owner = ?
            ORDER BY table_name
          )
          WHERE ROWNUM <= ?
        `,
        values: [owner, limit],
        timeout: timeoutMs
      });
      return rows as unknown[];
    }

    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} *
        FROM (
          SELECT table_name, tablespace_name, num_rows
          FROM user_tables
          ORDER BY table_name
        )
        WHERE ROWNUM <= ?
      `,
      values: [limit],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const resolvedSchema = schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (!resolvedSchema) {
    return [
      {
        notice: "No MySQL database is selected. Pass the schema argument to ob_list_tables."
      }
    ];
  }

  const [rows] = await pool.query({
    sql: `
      SELECT table_schema, table_name, table_type, engine
      FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY table_name
      LIMIT ?
    `,
    values: [resolvedSchema, limit],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

export async function describeTable(
  pool: ObPool,
  mode: CompatibilityMode,
  table: string,
  schema: string | undefined,
  timeoutMs: number
): Promise<unknown[]> {
  if (mode === "oracle") {
    const tableName = table.trim().toUpperCase();
    const owner = schema?.trim().toUpperCase();
    if (await isCurrentOracleSchema(pool, owner, timeoutMs)) {
      const resolvedOwner = owner ?? (await currentOracleSchema(pool, timeoutMs)) ?? "";
      const [rows] = await pool.query({
        sql: `
          SELECT ${oracleTimeoutHint(timeoutMs)} ? AS owner, table_name, column_name, data_type, data_length, data_precision,
                 data_scale, data_default, nullable, column_id
          FROM user_tab_columns
          WHERE table_name = ?
          ORDER BY table_name, column_id
        `,
        values: [resolvedOwner, tableName],
        timeout: timeoutMs
      });
      return rows as unknown[];
    }

    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} owner, table_name, column_name, data_type, data_length, data_precision,
               data_scale, data_default, nullable, column_id
        FROM all_tab_columns
        WHERE table_name = ?
          AND (? IS NULL OR owner = ?)
        ORDER BY owner, table_name, column_id
      `,
      values: [tableName, owner ?? null, owner ?? null],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const resolvedSchema = schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (!resolvedSchema) {
    throw new Error("No MySQL database is selected. Pass the schema argument to ob_describe_table.");
  }

  const [rows] = await pool.query({
    sql: `
      SELECT table_schema, table_name, column_name, column_type, data_type,
             is_nullable, column_default, column_key, extra, ordinal_position
      FROM information_schema.columns
      WHERE table_name = ?
        AND table_schema = ?
      ORDER BY table_schema, table_name, ordinal_position
    `,
    values: [table, resolvedSchema],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

export async function getTableDdlMetadata(
  pool: ObPool,
  mode: CompatibilityMode,
  table: string,
  schema: string | undefined,
  timeoutMs: number
): Promise<TableDdlMetadata> {
  const resolvedSchema =
    mode === "oracle"
      ? schema?.trim().toUpperCase() || (await currentOracleSchema(pool, timeoutMs))
      : schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (mode === "mysql" && !resolvedSchema) {
    throw new Error("No MySQL database is selected. Pass the schema argument to ob_get_table_ddl.");
  }

  const resolvedTable = mode === "oracle" ? table.trim().toUpperCase() : table.trim();
  const columns = await describeTable(pool, mode, resolvedTable, resolvedSchema, timeoutMs);
  const indexes = await listIndexes(pool, mode, resolvedTable, resolvedSchema, timeoutMs);
  const constraints = await listConstraints(pool, mode, resolvedTable, resolvedSchema, timeoutMs);
  const partitions = await listPartitions(pool, mode, resolvedTable, resolvedSchema, timeoutMs);
  const nativeDdl = mode === "mysql" && resolvedSchema ? await showMysqlCreateTable(pool, resolvedSchema, resolvedTable, timeoutMs) : undefined;

  return {
    mode,
    schema: resolvedSchema,
    table: resolvedTable,
    nativeDdl,
    structuredDdl: renderStructuredTableDdl(mode, resolvedSchema, resolvedTable, columns, indexes, constraints, partitions),
    columns,
    indexes,
    constraints,
    partitions,
    warnings: nativeDdl
      ? []
      : ["Native DDL is not available for this compatibility mode or endpoint; structured metadata was used."]
  };
}

export async function findRelatedTables(
  pool: ObPool,
  mode: CompatibilityMode,
  table: string,
  schema: string | undefined,
  depth: number,
  limit: number,
  timeoutMs: number
): Promise<RelatedTablesResult> {
  const resolvedSchema =
    mode === "oracle"
      ? schema?.trim().toUpperCase() || (await currentOracleSchema(pool, timeoutMs))
      : schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (mode === "mysql" && !resolvedSchema) {
    throw new Error("No MySQL database is selected. Pass the schema argument to ob_find_related_tables.");
  }

  const root = {
    schema: resolvedSchema,
    table: mode === "oracle" ? table.trim().toUpperCase() : table.trim()
  };
  const maxDepth = Math.max(1, Math.min(depth, 3));
  const maxRelations = Math.max(1, limit);
  const relations: TableRelationship[] = [];
  const relationKeys = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ schema?: string; table: string; depth: number }> = [{ ...root, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const visitKey = tableKey(mode, current.schema, current.table);
    if (visited.has(visitKey) || current.depth >= maxDepth) {
      continue;
    }
    visited.add(visitKey);
    const discovered = await discoverRelationshipsForTable(pool, mode, current.schema, current.table, current.depth + 1, maxRelations, timeoutMs);

    for (const relation of discovered) {
      const key = relationshipKey(mode, relation);
      if (relationKeys.has(key)) {
        continue;
      }
      if (relations.length >= maxRelations) {
        truncated = true;
        break;
      }
      relationKeys.add(key);
      relations.push(relation);
      if (relation.depth < maxDepth) {
        queue.push({ schema: relation.targetSchema, table: relation.targetTable, depth: relation.depth });
        queue.push({ schema: relation.sourceSchema, table: relation.sourceTable, depth: relation.depth });
      }
    }
    if (truncated) {
      break;
    }
  }

  return {
    mode,
    root,
    depth: maxDepth,
    truncated,
    relations
  };
}

export async function searchCatalog(
  pool: ObPool,
  mode: CompatibilityMode,
  query: string,
  schema: string | undefined,
  limit: number,
  timeoutMs: number
): Promise<unknown[]> {
  const pattern = `%${query}%`;
  if (mode === "oracle") {
    const owner = schema?.trim().toUpperCase();
    if (await isCurrentOracleSchema(pool, owner, timeoutMs)) {
      const resolvedOwner = owner ?? (await currentOracleSchema(pool, timeoutMs)) ?? "";
      const [rows] = await pool.query({
        sql: `
          SELECT ${oracleTimeoutHint(timeoutMs)} *
          FROM (
            SELECT 'table' AS match_type, ? AS owner, table_name, NULL AS column_name, NULL AS comment_text
            FROM user_tables
            WHERE LOWER(table_name) LIKE LOWER(?)
            UNION ALL
            SELECT 'column' AS match_type, ? AS owner, table_name, column_name, NULL AS comment_text
            FROM user_tab_columns
            WHERE LOWER(table_name) LIKE LOWER(?) OR LOWER(column_name) LIKE LOWER(?)
            ORDER BY table_name, column_name
          )
          WHERE ROWNUM <= ?
        `,
        values: [resolvedOwner, pattern, resolvedOwner, pattern, pattern, limit],
        timeout: timeoutMs
      });
      return rows as unknown[];
    }

    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} *
        FROM (
          SELECT 'table' AS match_type, owner, table_name, NULL AS column_name, NULL AS comment_text
          FROM all_tables
          WHERE (? IS NULL OR owner = ?)
            AND (LOWER(owner) LIKE LOWER(?) OR LOWER(table_name) LIKE LOWER(?))
          UNION ALL
          SELECT 'column' AS match_type, owner, table_name, column_name, NULL AS comment_text
          FROM all_tab_columns
          WHERE (? IS NULL OR owner = ?)
            AND (LOWER(owner) LIKE LOWER(?) OR LOWER(table_name) LIKE LOWER(?) OR LOWER(column_name) LIKE LOWER(?))
          ORDER BY owner, table_name, column_name
        )
        WHERE ROWNUM <= ?
      `,
      values: [owner ?? null, owner ?? null, pattern, pattern, owner ?? null, owner ?? null, pattern, pattern, pattern, limit],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const [rows] = await pool.query({
    sql: `
      SELECT *
      FROM (
        SELECT 'table' AS match_type, table_schema, table_name, NULL AS column_name, table_comment AS comment_text
        FROM information_schema.tables
        WHERE (? IS NULL OR table_schema = ?)
          AND (table_schema LIKE ? OR table_name LIKE ? OR table_comment LIKE ?)
        UNION ALL
        SELECT 'column' AS match_type, table_schema, table_name, column_name, column_comment AS comment_text
        FROM information_schema.columns
        WHERE (? IS NULL OR table_schema = ?)
          AND (table_schema LIKE ? OR table_name LIKE ? OR column_name LIKE ? OR column_comment LIKE ?)
      ) AS catalog_matches
      ORDER BY table_schema, table_name, column_name
      LIMIT ?
    `,
    values: [schema ?? null, schema ?? null, pattern, pattern, pattern, schema ?? null, schema ?? null, pattern, pattern, pattern, pattern, limit],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

export async function listIndexes(
  pool: ObPool,
  mode: CompatibilityMode,
  table: string,
  schema: string | undefined,
  timeoutMs: number
): Promise<unknown[]> {
  if (mode === "oracle") {
    const owner = schema?.trim().toUpperCase();
    if (await isCurrentOracleSchema(pool, owner, timeoutMs)) {
      const resolvedOwner = owner ?? (await currentOracleSchema(pool, timeoutMs)) ?? "";
      const [rows] = await pool.query({
        sql: `
          SELECT ${oracleTimeoutHint(timeoutMs)} ? AS owner, i.table_name, i.index_name, i.uniqueness, c.column_name, c.column_position
          FROM user_indexes i
          JOIN user_ind_columns c
            ON c.index_name = i.index_name
           AND c.table_name = i.table_name
          WHERE i.table_name = ?
          ORDER BY i.index_name, c.column_position
        `,
        values: [resolvedOwner, table.trim().toUpperCase()],
        timeout: timeoutMs
      });
      return rows as unknown[];
    }

    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} i.owner, i.table_name, i.index_name, i.uniqueness, c.column_name, c.column_position
        FROM all_indexes i
        JOIN all_ind_columns c
          ON c.index_owner = i.owner
         AND c.index_name = i.index_name
         AND c.table_owner = i.owner
         AND c.table_name = i.table_name
        WHERE i.table_name = ?
          AND (? IS NULL OR i.owner = ?)
        ORDER BY i.owner, i.index_name, c.column_position
      `,
      values: [table.trim().toUpperCase(), owner ?? null, owner ?? null],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const resolvedSchema = schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (!resolvedSchema) {
    throw new Error("No MySQL database is selected. Pass the schema argument.");
  }
  const [rows] = await pool.query({
    sql: `
      SELECT table_schema, table_name, index_name, non_unique, seq_in_index, column_name, index_type
      FROM information_schema.statistics
      WHERE table_schema = ?
        AND table_name = ?
      ORDER BY index_name, seq_in_index
    `,
    values: [resolvedSchema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

export async function listConstraints(
  pool: ObPool,
  mode: CompatibilityMode,
  table: string,
  schema: string | undefined,
  timeoutMs: number
): Promise<unknown[]> {
  if (mode === "oracle") {
    const owner = schema?.trim().toUpperCase();
    if (await isCurrentOracleSchema(pool, owner, timeoutMs)) {
      const resolvedOwner = owner ?? (await currentOracleSchema(pool, timeoutMs)) ?? "";
      const [rows] = await pool.query({
        sql: `
          SELECT ${oracleTimeoutHint(timeoutMs)} owner, table_name, constraint_name, constraint_type, column_name, position, search_condition
          FROM (
            SELECT ? AS owner, c.table_name, c.constraint_name, c.constraint_type, cc.column_name, cc.position, c.search_condition
            FROM user_constraints c
            LEFT JOIN user_cons_columns cc
              ON cc.constraint_name = c.constraint_name
             AND cc.table_name = c.table_name
            WHERE c.table_name = ?
            UNION ALL
            SELECT ? AS owner, table_name, 'NOT_NULL_' || column_name AS constraint_name, 'NOT_NULL' AS constraint_type,
                   column_name, column_id AS position, NULL AS search_condition
            FROM user_tab_columns
            WHERE table_name = ?
              AND nullable = 'N'
          )
          ORDER BY constraint_name, position
        `,
        values: [resolvedOwner, table.trim().toUpperCase(), resolvedOwner, table.trim().toUpperCase()],
        timeout: timeoutMs
      });
      return rows as unknown[];
    }

    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} owner, table_name, constraint_name, constraint_type, column_name, position, search_condition
        FROM (
          SELECT c.owner, c.table_name, c.constraint_name, c.constraint_type, cc.column_name, cc.position, c.search_condition
          FROM all_constraints c
          LEFT JOIN all_cons_columns cc
            ON cc.owner = c.owner
           AND cc.constraint_name = c.constraint_name
           AND cc.table_name = c.table_name
          WHERE c.table_name = ?
            AND (? IS NULL OR c.owner = ?)
          UNION ALL
          SELECT owner, table_name, 'NOT_NULL_' || column_name AS constraint_name, 'NOT_NULL' AS constraint_type,
                 column_name, column_id AS position, NULL AS search_condition
          FROM all_tab_columns
          WHERE table_name = ?
            AND nullable = 'N'
            AND (? IS NULL OR owner = ?)
        )
        ORDER BY owner, constraint_name, position
      `,
      values: [
        table.trim().toUpperCase(),
        owner ?? null,
        owner ?? null,
        table.trim().toUpperCase(),
        owner ?? null,
        owner ?? null
      ],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const resolvedSchema = schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (!resolvedSchema) {
    throw new Error("No MySQL database is selected. Pass the schema argument.");
  }
  const [rows] = await pool.query({
    sql: `
      SELECT table_schema, table_name, constraint_name, constraint_type,
             column_name, ordinal_position, referenced_table_schema,
             referenced_table_name, referenced_column_name
      FROM (
        SELECT tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type,
               kcu.column_name, kcu.ordinal_position, kcu.referenced_table_schema,
               kcu.referenced_table_name, kcu.referenced_column_name
        FROM information_schema.table_constraints tc
        LEFT JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
         AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = ?
          AND tc.table_name = ?
        UNION ALL
        SELECT table_schema, table_name, CONCAT('NOT_NULL_', column_name) AS constraint_name,
               'NOT_NULL' AS constraint_type, column_name, ordinal_position,
               NULL AS referenced_table_schema, NULL AS referenced_table_name, NULL AS referenced_column_name
        FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
          AND is_nullable = 'NO'
      ) AS constraints_with_not_null
      ORDER BY constraint_name, ordinal_position
    `,
    values: [resolvedSchema, table, resolvedSchema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

export async function listPartitions(
  pool: ObPool,
  mode: CompatibilityMode,
  table: string,
  schema: string | undefined,
  timeoutMs: number
): Promise<unknown[]> {
  if (mode === "oracle") {
    const owner = schema?.trim().toUpperCase();
    if (await isCurrentOracleSchema(pool, owner, timeoutMs)) {
      const resolvedOwner = owner ?? (await currentOracleSchema(pool, timeoutMs)) ?? "";
      const [rows] = await pool.query({
        sql: `
          SELECT ${oracleTimeoutHint(timeoutMs)} ? AS table_owner, table_name, partition_name, high_value, partition_position, tablespace_name, num_rows
          FROM user_tab_partitions
          WHERE table_name = ?
          ORDER BY table_name, partition_position
        `,
        values: [resolvedOwner, table.trim().toUpperCase()],
        timeout: timeoutMs
      });
      return rows as unknown[];
    }

    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} table_owner, table_name, partition_name, high_value, partition_position, tablespace_name, num_rows
        FROM all_tab_partitions
        WHERE table_name = ?
          AND (? IS NULL OR table_owner = ?)
        ORDER BY table_owner, table_name, partition_position
      `,
      values: [table.trim().toUpperCase(), owner ?? null, owner ?? null],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const resolvedSchema = schema?.trim() || (await currentMysqlSchema(pool, timeoutMs));
  if (!resolvedSchema) {
    throw new Error("No MySQL database is selected. Pass the schema argument.");
  }
  const [rows] = await pool.query({
    sql: `
      SELECT table_schema, table_name, partition_name, subpartition_name, partition_method,
             partition_expression, partition_description, table_rows
      FROM information_schema.partitions
      WHERE table_schema = ?
        AND table_name = ?
        AND partition_name IS NOT NULL
      ORDER BY partition_ordinal_position, subpartition_ordinal_position
    `,
    values: [resolvedSchema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

export async function sampleRows(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  columns: string[],
  limit: number,
  timeoutMs: number
): Promise<QueryOutput> {
  if (columns.length === 0) {
    return { rowCount: 0, rows: [], truncated: false, fields: [] };
  }
  const tableName = qualifiedTableName(mode, schema, table);
  const columnList = columns.map((column) => quoteIdentifier(mode, column)).join(", ");
  const sql =
    mode === "oracle"
      ? `SELECT ${oracleTimeoutHint(timeoutMs)} * FROM (SELECT ${columnList} FROM ${tableName}) WHERE ROWNUM <= ${limit + 1}`
      : `SELECT ${columnList} FROM ${tableName} LIMIT ${limit + 1}`;
  return runQuery(pool, sql, [], limit, timeoutMs);
}

async function discoverRelationshipsForTable(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  depth: number,
  limit: number,
  timeoutMs: number
): Promise<TableRelationship[]> {
  const direct = await queryForeignKeyRelationships(pool, mode, schema, table, "outbound", depth, timeoutMs);
  const inbound = await queryForeignKeyRelationships(pool, mode, schema, table, "inbound", depth, timeoutMs);
  const inferredOutbound = await inferOutboundNamingRelationships(pool, mode, schema, table, depth, limit, timeoutMs);
  const inferredInbound = await inferInboundNamingRelationships(pool, mode, schema, table, depth, limit, timeoutMs);
  const output: TableRelationship[] = [];
  const keys = new Set<string>();

  for (const relation of [...direct, ...inbound, ...inferredOutbound, ...inferredInbound]) {
    const pairKey = relationshipPairKey(mode, relation);
    const exactKey = relationshipKey(mode, relation);
    if (relation.relationType === "name_inference" && keys.has(pairKey)) {
      continue;
    }
    if (keys.has(exactKey)) {
      continue;
    }
    keys.add(exactKey);
    keys.add(pairKey);
    output.push(relation);
  }
  return output.slice(0, limit);
}

async function queryForeignKeyRelationships(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  direction: "outbound" | "inbound",
  depth: number,
  timeoutMs: number
): Promise<TableRelationship[]> {
  const rows = mode === "oracle"
    ? await queryOracleForeignKeyRows(pool, schema, table, direction, timeoutMs)
    : await queryMysqlForeignKeyRows(pool, schema, table, direction, timeoutMs);
  const grouped = groupBy(rows, (row) => {
    const record = rowRecord(row);
    return [
      stringField(record, "constraint_name", "CONSTRAINT_NAME") ?? "",
      stringField(record, "source_schema", "SOURCE_SCHEMA") ?? "",
      stringField(record, "source_table", "SOURCE_TABLE") ?? "",
      stringField(record, "target_schema", "TARGET_SCHEMA") ?? "",
      stringField(record, "target_table", "TARGET_TABLE") ?? ""
    ].join(".");
  });

  return [...grouped.values()].map((group) => {
    const first = rowRecord(group[0]);
    const sourceColumns = group
      .map((row) => stringField(rowRecord(row), "source_column", "SOURCE_COLUMN"))
      .filter((value): value is string => Boolean(value));
    const targetColumns = group
      .map((row) => stringField(rowRecord(row), "target_column", "TARGET_COLUMN"))
      .filter((value): value is string => Boolean(value));
    return {
      relationType: direction === "outbound" ? "foreign_key" : "referenced_by",
      direction,
      confidence: 1,
      sourceSchema: stringField(first, "source_schema", "SOURCE_SCHEMA"),
      sourceTable: stringField(first, "source_table", "SOURCE_TABLE") ?? table,
      sourceColumns,
      targetSchema: stringField(first, "target_schema", "TARGET_SCHEMA"),
      targetTable: stringField(first, "target_table", "TARGET_TABLE") ?? table,
      targetColumns,
      constraintName: stringField(first, "constraint_name", "CONSTRAINT_NAME"),
      depth,
      evidence: [
        {
          type: direction === "outbound" ? "foreign_key" : "referenced_by",
          detail: "Relationship comes from database foreign-key metadata.",
          columns: sourceColumns
        }
      ]
    };
  });
}

async function queryMysqlForeignKeyRows(
  pool: ObPool,
  schema: string | undefined,
  table: string,
  direction: "outbound" | "inbound",
  timeoutMs: number
): Promise<unknown[]> {
  if (!schema) {
    return [];
  }
  const where =
    direction === "outbound"
      ? "kcu.table_schema = ? AND kcu.table_name = ?"
      : "kcu.referenced_table_schema = ? AND kcu.referenced_table_name = ?";
  const [rows] = await pool.query({
    sql: `
      SELECT kcu.constraint_name,
             kcu.table_schema AS source_schema,
             kcu.table_name AS source_table,
             kcu.column_name AS source_column,
             kcu.referenced_table_schema AS target_schema,
             kcu.referenced_table_name AS target_table,
             kcu.referenced_column_name AS target_column
      FROM information_schema.key_column_usage kcu
      WHERE ${where}
        AND kcu.referenced_table_name IS NOT NULL
      ORDER BY kcu.constraint_name, kcu.ordinal_position
    `,
    values: [schema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function queryOracleForeignKeyRows(
  pool: ObPool,
  schema: string | undefined,
  table: string,
  direction: "outbound" | "inbound",
  timeoutMs: number
): Promise<unknown[]> {
  if (!schema) {
    return [];
  }
  const where = direction === "outbound" ? "c.owner = ? AND c.table_name = ?" : "r.owner = ? AND r.table_name = ?";
  const [rows] = await pool.query({
    sql: `
      SELECT ${oracleTimeoutHint(timeoutMs)} c.constraint_name,
             c.owner AS source_schema,
             c.table_name AS source_table,
             cc.column_name AS source_column,
             r.owner AS target_schema,
             r.table_name AS target_table,
             rcc.column_name AS target_column
      FROM all_constraints c
      JOIN all_cons_columns cc
        ON cc.owner = c.owner
       AND cc.constraint_name = c.constraint_name
       AND cc.table_name = c.table_name
      JOIN all_constraints r
        ON r.owner = c.r_owner
       AND r.constraint_name = c.r_constraint_name
      JOIN all_cons_columns rcc
        ON rcc.owner = r.owner
       AND rcc.constraint_name = r.constraint_name
       AND rcc.position = cc.position
      WHERE c.constraint_type = 'R'
        AND ${where}
      ORDER BY c.constraint_name, cc.position
    `,
    values: [schema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function inferOutboundNamingRelationships(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  depth: number,
  limit: number,
  timeoutMs: number
): Promise<TableRelationship[]> {
  if (!schema) {
    return [];
  }
  const columns = await describeTable(pool, mode, table, schema, timeoutMs);
  const indexes = await listIndexes(pool, mode, table, schema, timeoutMs);
  const indexedColumns = new Set(
    indexes
      .map((row) => normalizeName(mode, stringField(rowRecord(row), "column_name", "COLUMN_NAME") ?? ""))
      .filter(Boolean)
  );
  const relations: TableRelationship[] = [];

  for (const column of columns.map(metadataColumnName).filter((value): value is string => Boolean(value))) {
    const normalizedColumn = normalizeName(mode, column);
    const prefix = idColumnPrefix(normalizedColumn);
    if (!prefix) {
      continue;
    }
    const candidateTables = await findTablesByNames(pool, mode, schema, tableNameCandidates(prefix), timeoutMs);
    for (const candidate of candidateTables) {
      if (relations.length >= limit) {
        return relations;
      }
      const candidateRecord = rowRecord(candidate);
      const targetSchema = stringField(candidateRecord, "table_schema", "TABLE_SCHEMA", "owner", "OWNER") ?? schema;
      const targetTable = stringField(candidateRecord, "table_name", "TABLE_NAME");
      if (!targetTable || sameName(mode, targetTable, table)) {
        continue;
      }
      const targetColumn = await primaryOrUniqueColumn(pool, mode, targetSchema, targetTable, "id", timeoutMs);
      if (!targetColumn) {
        continue;
      }
      const sourceIndexed = indexedColumns.has(normalizedColumn);
      relations.push({
        relationType: "name_inference",
        direction: "outbound",
        confidence: sourceIndexed ? 0.68 : 0.55,
        sourceSchema: schema,
        sourceTable: table,
        sourceColumns: [column],
        targetSchema,
        targetTable,
        targetColumns: [targetColumn],
        depth,
        evidence: [
          {
            type: "naming",
            detail: `Column ${column} follows the ${prefix}_id naming pattern and matches table ${targetTable}.`,
            columns: [column]
          },
          {
            type: "primary_or_unique_key",
            detail: `Target column ${targetColumn} is covered by a primary or unique key.`,
            columns: [targetColumn]
          },
          ...(sourceIndexed
            ? [{
                type: "index" as const,
                detail: `Source column ${column} is indexed.`,
                columns: [column]
              }]
            : [])
        ]
      });
    }
  }
  return relations;
}

async function inferInboundNamingRelationships(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  depth: number,
  limit: number,
  timeoutMs: number
): Promise<TableRelationship[]> {
  if (!schema) {
    return [];
  }
  const targetColumn = await primaryOrUniqueColumn(pool, mode, schema, table, "id", timeoutMs);
  if (!targetColumn) {
    return [];
  }
  const candidateColumns = idColumnNamesForTable(mode, table);
  const rows = mode === "oracle"
    ? await queryOracleColumnsByName(pool, schema, table, candidateColumns, limit, timeoutMs)
    : await queryMysqlColumnsByName(pool, schema, table, candidateColumns, limit, timeoutMs);

  return rows.map((row) => {
    const record = rowRecord(row);
    const sourceSchema = stringField(record, "table_schema", "TABLE_SCHEMA", "owner", "OWNER") ?? schema;
    const sourceTable = stringField(record, "table_name", "TABLE_NAME") ?? "";
    const sourceColumn = stringField(record, "column_name", "COLUMN_NAME") ?? "";
    const indexed = Boolean(numberField(record, "indexed", "INDEXED"));
    return {
      relationType: "name_inference",
      direction: "inbound",
      confidence: indexed ? 0.66 : 0.52,
      sourceSchema,
      sourceTable,
      sourceColumns: [sourceColumn],
      targetSchema: schema,
      targetTable: table,
      targetColumns: [targetColumn],
      depth,
      evidence: [
        {
          type: "naming",
          detail: `Column ${sourceColumn} matches the expected reference name for table ${table}.`,
          columns: [sourceColumn]
        },
        {
          type: "primary_or_unique_key",
          detail: `Target column ${targetColumn} is covered by a primary or unique key.`,
          columns: [targetColumn]
        },
        ...(indexed
          ? [{
              type: "index" as const,
              detail: `Source column ${sourceColumn} is indexed.`,
              columns: [sourceColumn]
            }]
          : [])
      ]
    };
  });
}

async function findTablesByNames(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string,
  names: string[],
  timeoutMs: number
): Promise<unknown[]> {
  const normalized = [...new Set(names.map((name) => normalizeName(mode, name)).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }
  const placeholders = normalized.map(() => "?").join(", ");
  if (mode === "oracle") {
    const [rows] = await pool.query({
      sql: `
        SELECT ${oracleTimeoutHint(timeoutMs)} owner, table_name
        FROM all_tables
        WHERE owner = ?
          AND table_name IN (${placeholders})
        ORDER BY table_name
      `,
      values: [schema, ...normalized],
      timeout: timeoutMs
    });
    return rows as unknown[];
  }

  const [rows] = await pool.query({
    sql: `
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = ?
        AND LOWER(table_name) IN (${placeholders})
      ORDER BY table_name
    `,
    values: [schema, ...normalized],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function primaryOrUniqueColumn(
  pool: ObPool,
  mode: CompatibilityMode,
  schema: string,
  table: string,
  preferredColumn: string,
  timeoutMs: number
): Promise<string | undefined> {
  const normalizedColumn = normalizeName(mode, preferredColumn);
  const rows = mode === "oracle"
    ? await queryOraclePrimaryOrUniqueColumns(pool, schema, table, timeoutMs)
    : await queryMysqlPrimaryOrUniqueColumns(pool, schema, table, timeoutMs);
  const values = rows
    .map((row) => stringField(rowRecord(row), "column_name", "COLUMN_NAME"))
    .filter((value): value is string => Boolean(value));
  return values.find((value) => normalizeName(mode, value) === normalizedColumn) ?? values[0];
}

async function queryMysqlPrimaryOrUniqueColumns(pool: ObPool, schema: string, table: string, timeoutMs: number): Promise<unknown[]> {
  const [rows] = await pool.query({
    sql: `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
       AND kcu.table_name = tc.table_name
      WHERE tc.table_schema = ?
        AND tc.table_name = ?
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      ORDER BY CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 0 ELSE 1 END, kcu.ordinal_position
    `,
    values: [schema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function queryOraclePrimaryOrUniqueColumns(pool: ObPool, schema: string, table: string, timeoutMs: number): Promise<unknown[]> {
  const [rows] = await pool.query({
    sql: `
      SELECT ${oracleTimeoutHint(timeoutMs)} cc.column_name
      FROM all_constraints c
      JOIN all_cons_columns cc
        ON cc.owner = c.owner
       AND cc.constraint_name = c.constraint_name
       AND cc.table_name = c.table_name
      WHERE c.owner = ?
        AND c.table_name = ?
        AND c.constraint_type IN ('P', 'U')
      ORDER BY CASE WHEN c.constraint_type = 'P' THEN 0 ELSE 1 END, cc.position
    `,
    values: [schema, table],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function queryMysqlColumnsByName(
  pool: ObPool,
  schema: string,
  table: string,
  columnNames: string[],
  limit: number,
  timeoutMs: number
): Promise<unknown[]> {
  const normalized = [...new Set(columnNames.map((name) => name.toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }
  const placeholders = normalized.map(() => "?").join(", ");
  const [rows] = await pool.query({
    sql: `
      SELECT c.table_schema, c.table_name, c.column_name,
             MAX(CASE WHEN s.index_name IS NULL THEN 0 ELSE 1 END) AS indexed
      FROM information_schema.columns c
      LEFT JOIN information_schema.statistics s
        ON s.table_schema = c.table_schema
       AND s.table_name = c.table_name
       AND s.column_name = c.column_name
      WHERE c.table_schema = ?
        AND c.table_name <> ?
        AND LOWER(c.column_name) IN (${placeholders})
      GROUP BY c.table_schema, c.table_name, c.column_name
      ORDER BY indexed DESC, c.table_name, c.column_name
      LIMIT ?
    `,
    values: [schema, table, ...normalized, limit],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function queryOracleColumnsByName(
  pool: ObPool,
  schema: string,
  table: string,
  columnNames: string[],
  limit: number,
  timeoutMs: number
): Promise<unknown[]> {
  const normalized = [...new Set(columnNames.map((name) => name.toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }
  const placeholders = normalized.map(() => "?").join(", ");
  const [rows] = await pool.query({
    sql: `
      SELECT ${oracleTimeoutHint(timeoutMs)} *
      FROM (
        SELECT c.owner, c.table_name, c.column_name,
               MAX(CASE WHEN ic.index_name IS NULL THEN 0 ELSE 1 END) AS indexed
        FROM all_tab_columns c
        LEFT JOIN all_ind_columns ic
          ON ic.table_owner = c.owner
         AND ic.table_name = c.table_name
         AND ic.column_name = c.column_name
        WHERE c.owner = ?
          AND c.table_name <> ?
          AND c.column_name IN (${placeholders})
        GROUP BY c.owner, c.table_name, c.column_name
        ORDER BY indexed DESC, c.table_name, c.column_name
      )
      WHERE ROWNUM <= ?
    `,
    values: [schema, table, ...normalized, limit],
    timeout: timeoutMs
  });
  return rows as unknown[];
}

async function showMysqlCreateTable(pool: ObPool, schema: string, table: string, timeoutMs: number): Promise<string | undefined> {
  const [rows] = await pool.query({
    sql: `SHOW CREATE TABLE ${quoteIdentifier("mysql", schema)}.${quoteIdentifier("mysql", table)}`,
    timeout: timeoutMs
  });
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const ddl = first?.["Create Table"] ?? first?.["CREATE TABLE"];
  return typeof ddl === "string" && ddl.trim() ? ddl : undefined;
}

export function renderStructuredTableDdl(
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  columns: unknown[],
  indexes: unknown[],
  constraints: unknown[],
  partitions: unknown[]
): string {
  const tableName = qualifiedTableName(mode, schema, table);
  const definitions = [
    ...columns.map((column) => `  ${renderColumnDefinition(mode, column)}`),
    ...renderConstraintDefinitions(mode, constraints).map((constraint) => `  ${constraint}`)
  ].filter((line) => line.trim());
  const body = definitions.length > 0 ? definitions.join(",\n") : "  /* no visible columns */";
  const statements = [`CREATE TABLE ${tableName} (\n${body}\n);`];
  const indexStatements = renderIndexStatements(mode, schema, table, indexes, constraints);
  statements.push(...indexStatements);
  if (partitions.length > 0) {
    statements.push(`/* Partition metadata is available in the structured partitions field. */`);
  }
  return statements.join("\n\n");
}

function renderColumnDefinition(mode: CompatibilityMode, row: unknown): string {
  const column = rowRecord(row);
  const name = stringField(column, "column_name", "COLUMN_NAME") ?? "UNKNOWN_COLUMN";
  const nullable = stringField(column, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
  const defaultValue = fieldValue(column, "column_default", "COLUMN_DEFAULT", "data_default", "DATA_DEFAULT");
  const extra = stringField(column, "extra", "EXTRA");
  const parts = [quoteIdentifier(mode, mode === "oracle" ? name.toUpperCase() : name), columnType(mode, column)];
  if (defaultValue != null && String(defaultValue).trim() !== "") {
    parts.push(`DEFAULT ${String(defaultValue).trim()}`);
  }
  if (nullable && ["NO", "N"].includes(nullable.toUpperCase())) {
    parts.push("NOT NULL");
  }
  if (mode === "mysql" && extra) {
    parts.push(extra);
  }
  return parts.join(" ");
}

function columnType(mode: CompatibilityMode, column: Record<string, unknown>): string {
  if (mode === "mysql") {
    return stringField(column, "column_type", "COLUMN_TYPE", "data_type", "DATA_TYPE") ?? "UNKNOWN";
  }

  const dataType = stringField(column, "data_type", "DATA_TYPE") ?? "UNKNOWN";
  const length = numberField(column, "data_length", "DATA_LENGTH");
  const precision = numberField(column, "data_precision", "DATA_PRECISION");
  const scale = numberField(column, "data_scale", "DATA_SCALE");
  if (["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType) && length != null) {
    return `${dataType}(${length})`;
  }
  if (dataType === "NUMBER" && precision != null && scale != null) {
    return `${dataType}(${precision},${scale})`;
  }
  if (dataType === "NUMBER" && precision != null) {
    return `${dataType}(${precision})`;
  }
  if (dataType.startsWith("TIMESTAMP") && scale != null) {
    return `${dataType}(${scale})`;
  }
  return dataType;
}

function renderConstraintDefinitions(mode: CompatibilityMode, rows: unknown[]): string[] {
  const grouped = groupBy(rows, (row) => stringField(rowRecord(row), "constraint_name", "CONSTRAINT_NAME") ?? "");
  const output: string[] = [];
  for (const [name, group] of grouped) {
    if (!name || name.startsWith("NOT_NULL_")) {
      continue;
    }
    const first = rowRecord(group[0]);
    const type = stringField(first, "constraint_type", "CONSTRAINT_TYPE") ?? "";
    const columns = group
      .map((row) => stringField(rowRecord(row), "column_name", "COLUMN_NAME"))
      .filter((value): value is string => Boolean(value));
    if (columns.length === 0) {
      continue;
    }
    const columnList = columns.map((column) => quoteIdentifier(mode, mode === "oracle" ? column.toUpperCase() : column)).join(", ");
    const quotedName = quoteIdentifier(mode, mode === "oracle" ? name.toUpperCase() : name);
    if (["PRIMARY KEY", "P"].includes(type)) {
      output.push(`CONSTRAINT ${quotedName} PRIMARY KEY (${columnList})`);
    } else if (["UNIQUE", "U"].includes(type)) {
      output.push(`CONSTRAINT ${quotedName} UNIQUE (${columnList})`);
    } else if (["FOREIGN KEY", "R"].includes(type)) {
      output.push(renderForeignKeyDefinition(mode, quotedName, columnList, first));
    } else if (["CHECK", "C"].includes(type)) {
      const condition = stringField(first, "search_condition", "SEARCH_CONDITION");
      if (condition) {
        output.push(`CONSTRAINT ${quotedName} CHECK (${condition})`);
      }
    }
  }
  return output;
}

function renderForeignKeyDefinition(
  mode: CompatibilityMode,
  quotedName: string,
  columnList: string,
  first: Record<string, unknown>
): string {
  const referencedSchema = stringField(first, "referenced_table_schema", "REFERENCED_TABLE_SCHEMA", "referenced_owner", "REFERENCED_OWNER");
  const referencedTable = stringField(first, "referenced_table_name", "REFERENCED_TABLE_NAME");
  const referencedColumn = stringField(first, "referenced_column_name", "REFERENCED_COLUMN_NAME");
  if (!referencedTable || !referencedColumn) {
    return `CONSTRAINT ${quotedName} FOREIGN KEY (${columnList})`;
  }
  const target = qualifiedTableName(mode, referencedSchema, referencedTable);
  const targetColumn = quoteIdentifier(mode, mode === "oracle" ? referencedColumn.toUpperCase() : referencedColumn);
  return `CONSTRAINT ${quotedName} FOREIGN KEY (${columnList}) REFERENCES ${target} (${targetColumn})`;
}

function renderIndexStatements(
  mode: CompatibilityMode,
  schema: string | undefined,
  table: string,
  rows: unknown[],
  constraints: unknown[]
): string[] {
  const constraintNames = new Set(
    constraints
      .map((row) => stringField(rowRecord(row), "constraint_name", "CONSTRAINT_NAME"))
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toUpperCase())
  );
  const grouped = groupBy(rows, (row) => stringField(rowRecord(row), "index_name", "INDEX_NAME") ?? "");
  const output: string[] = [];
  for (const [name, group] of grouped) {
    if (!name || name.toUpperCase() === "PRIMARY" || constraintNames.has(name.toUpperCase())) {
      continue;
    }
    const first = rowRecord(group[0]);
    const columns = group
      .map((row) => stringField(rowRecord(row), "column_name", "COLUMN_NAME"))
      .filter((value): value is string => Boolean(value));
    if (columns.length === 0) {
      continue;
    }
    const unique = stringField(first, "uniqueness", "UNIQUENESS") === "UNIQUE" || numberField(first, "non_unique", "NON_UNIQUE") === 0;
    const columnList = columns.map((column) => quoteIdentifier(mode, mode === "oracle" ? column.toUpperCase() : column)).join(", ");
    const indexName = quoteIdentifier(mode, mode === "oracle" ? name.toUpperCase() : name);
    output.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${indexName} ON ${qualifiedTableName(mode, schema, table)} (${columnList});`);
  }
  return output;
}

function metadataColumnName(row: unknown): string | undefined {
  return stringField(rowRecord(row), "column_name", "COLUMN_NAME");
}

function idColumnPrefix(column: string): string | undefined {
  const match = /^(.+)_id$/.exec(column);
  return match?.[1] ? match[1] : undefined;
}

function tableNameCandidates(prefix: string): string[] {
  const candidates = [prefix, `${prefix}s`];
  if (prefix.endsWith("y")) {
    candidates.push(`${prefix.slice(0, -1)}ies`);
  }
  if (prefix.endsWith("s")) {
    candidates.push(prefix.slice(0, -1));
  }
  return candidates;
}

function idColumnNamesForTable(mode: CompatibilityMode, table: string): string[] {
  const normalized = normalizeName(mode, table);
  const candidates = [`${normalized}_id`];
  if (normalized.endsWith("s")) {
    candidates.push(`${normalized.slice(0, -1)}_id`);
  }
  if (normalized.endsWith("ies")) {
    candidates.push(`${normalized.slice(0, -3)}y_id`);
  }
  return [...new Set(candidates)];
}

function normalizeName(mode: CompatibilityMode, value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function sameName(mode: CompatibilityMode, left: string, right: string): boolean {
  return normalizeName(mode, left) === normalizeName(mode, right);
}

function tableKey(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  return `${schema ? normalizeName(mode, schema) : ""}.${normalizeName(mode, table)}`;
}

function relationshipPairKey(mode: CompatibilityMode, relation: TableRelationship): string {
  return [
    tableKey(mode, relation.sourceSchema, relation.sourceTable),
    relation.sourceColumns.map((column) => normalizeName(mode, column)).join(","),
    tableKey(mode, relation.targetSchema, relation.targetTable),
    relation.targetColumns.map((column) => normalizeName(mode, column)).join(",")
  ].join("->");
}

function relationshipKey(mode: CompatibilityMode, relation: TableRelationship): string {
  return `${relation.relationType}:${relationshipPairKey(mode, relation)}:${relation.constraintName ?? ""}`;
}

function rowRecord(row: unknown): Record<string, unknown> {
  return row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};
}

function fieldValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  return keys.map((key) => record[key]).find((value) => value != null);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = fieldValue(record, ...keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = fieldValue(record, ...keys);
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return grouped;
}

export async function verifyReadOnlyPermissions(
  pool: ObPool,
  mode: CompatibilityMode,
  timeoutMs: number
): Promise<PermissionVerification> {
  if (mode === "oracle") {
    return verifyOraclePermissions(pool, timeoutMs);
  }
  return verifyMysqlPermissions(pool, timeoutMs);
}

async function verifyMysqlPermissions(pool: ObPool, timeoutMs: number): Promise<PermissionVerification> {
  const [rows] = await pool.query({ sql: "SHOW GRANTS", timeout: timeoutMs });
  const grants = Array.isArray(rows)
    ? rows.flatMap((row) => Object.values(row as Record<string, unknown>)).filter((value): value is string => typeof value === "string")
    : [];
  const writablePrivileges = [...new Set(grants.flatMap(extractMysqlWritablePrivileges))].sort();

  return {
    ok: writablePrivileges.length === 0,
    severity: writablePrivileges.length === 0 ? "pass" : "fail",
    mode: "mysql",
    checked: ["SHOW GRANTS"],
    message:
      writablePrivileges.length === 0
        ? "Current MySQL-compatible user grants appear read-only."
        : "Current MySQL-compatible user has write, control, or administrative privileges.",
    grants,
    writablePrivileges
  };
}

async function verifyOraclePermissions(pool: ObPool, timeoutMs: number): Promise<PermissionVerification> {
  const privilegeResult = await queryFirstAvailable(pool, timeoutMs, [
    {
      name: "USER_SYS_PRIVS",
      sql: `SELECT ${oracleTimeoutHint(timeoutMs)} privilege FROM user_sys_privs ORDER BY privilege`
    },
    {
      name: "SYS.USER_SYS_PRIVS",
      sql: `SELECT ${oracleTimeoutHint(timeoutMs)} privilege FROM sys.user_sys_privs ORDER BY privilege`
    }
  ]);
  if (!privilegeResult) {
    return {
      ok: false,
      severity: "warn",
      mode: "oracle",
      checked: ["USER_SYS_PRIVS", "SYS.USER_SYS_PRIVS"],
      message: "Could not inspect Oracle-compatible session privileges on this endpoint.",
      writablePrivileges: [],
      error: "No supported Oracle-compatible privilege view was accessible."
    };
  }

  const roleResult = await queryFirstAvailable(pool, timeoutMs, [
    {
      name: "USER_ROLE_PRIVS",
      sql: `SELECT ${oracleTimeoutHint(timeoutMs)} granted_role FROM user_role_privs ORDER BY granted_role`
    },
    {
      name: "SYS.USER_ROLE_PRIVS",
      sql: `SELECT ${oracleTimeoutHint(timeoutMs)} granted_role FROM sys.user_role_privs ORDER BY granted_role`
    }
  ]);
  const privileges = columnValues(privilegeResult.rows, ["privilege", "PRIVILEGE"]);
  const roles = roleResult ? columnValues(roleResult.rows, ["granted_role", "GRANTED_ROLE"]) : [];
  const writablePrivileges = [
    ...new Set([
      ...privileges.filter(isOracleWritablePrivilege).map(normalizePrivilege),
      ...roles.filter(isOracleWritableRole).map((role) => `ROLE:${normalizePrivilege(role)}`)
    ])
  ].sort();

  return {
    ok: writablePrivileges.length === 0,
    severity: writablePrivileges.length === 0 ? "pass" : "fail",
    mode: "oracle",
    checked: [privilegeResult.name, ...(roleResult ? [roleResult.name] : [])],
    message:
      writablePrivileges.length === 0
        ? "Current Oracle-compatible session privileges appear read-only."
        : "Current Oracle-compatible session has write, control, or administrative privileges.",
    privileges: [...privileges, ...roles.map((role) => `ROLE:${role}`)],
    writablePrivileges
  };
}

async function queryFirstAvailable(
  pool: ObPool,
  timeoutMs: number,
  queries: Array<{ name: string; sql: string }>
): Promise<{ name: string; rows: unknown[] } | undefined> {
  for (const query of queries) {
    try {
      const [rows] = await pool.query({ sql: query.sql, timeout: timeoutMs });
      return {
        name: query.name,
        rows: Array.isArray(rows) ? (rows as unknown[]) : []
      };
    } catch {
      // Try the next OceanBase/Oracle-compatible dictionary view.
    }
  }
  return undefined;
}

function columnValues(rows: unknown[], keys: string[]): string[] {
  return rows
    .map((row) => {
      const record = row as Record<string, unknown>;
      return keys.map((key) => record[key]).find((value): value is string => typeof value === "string");
    })
    .filter((value): value is string => typeof value === "string");
}

function extractMysqlWritablePrivileges(grant: string): string[] {
  const upper = grant.toUpperCase();
  const output: string[] = [];
  if (upper.includes("WITH GRANT OPTION")) {
    output.push("GRANT OPTION");
  }

  const match = /^\s*GRANT\s+(.+?)\s+ON\s+/i.exec(grant);
  if (!match?.[1]) {
    return output;
  }

  for (const privilege of splitMysqlPrivilegeList(match[1])) {
    const normalized = normalizePrivilege(privilege);
    if (!normalized || isMysqlSafePrivilege(normalized)) {
      continue;
    }
    output.push(normalized);
  }
  return output;
}

function splitMysqlPrivilegeList(value: string): string[] {
  const privileges: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (char === "," && depth === 0) {
      privileges.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  privileges.push(current);
  return privileges;
}

function isMysqlSafePrivilege(privilege: string): boolean {
  return ["USAGE", "SELECT", "SHOW VIEW", "SHOW DATABASES"].includes(privilege);
}

function isOracleWritablePrivilege(privilege: string): boolean {
  const normalized = normalizePrivilege(privilege);
  if (normalized === "CREATE SESSION") {
    return false;
  }
  return /^(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|EXECUTE|MERGE|LOCK|GRANT|DEBUG|FLASHBACK|ANALYZE)\b/.test(normalized);
}

function isOracleWritableRole(role: string): boolean {
  return ["DBA", "RESOURCE"].includes(normalizePrivilege(role));
}

function normalizePrivilege(value: string): string {
  return value.toUpperCase().replace(/\s*\(.*/, "").replace(/\s+/g, " ").trim();
}

async function currentMysqlSchema(pool: ObPool, timeoutMs: number): Promise<string | undefined> {
  const [rows] = await pool.query({ sql: "SELECT DATABASE() AS schema_name", timeout: timeoutMs });
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const value = first?.schema_name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function currentOracleSchema(pool: ObPool, timeoutMs: number): Promise<string | undefined> {
  const [rows] = await pool.query({ sql: `SELECT ${oracleTimeoutHint(timeoutMs)} USER AS schema_name FROM DUAL`, timeout: timeoutMs });
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const value = first?.schema_name ?? first?.SCHEMA_NAME;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined;
}

function timeoutMicros(timeoutMs: number): number {
  return Math.max(1_000, Math.trunc(timeoutMs * 1000));
}

function oracleTimeoutHint(timeoutMs: number): string {
  return `/*+ query_timeout(${timeoutMicros(timeoutMs)}) */`;
}


async function isCurrentOracleSchema(pool: ObPool, schema: string | undefined, timeoutMs: number): Promise<boolean> {
  const current = await currentOracleSchema(pool, timeoutMs);
  return !schema || (!!current && schema.trim().toUpperCase() === current);
}

function qualifiedTableName(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  const quotedTable = quoteIdentifier(mode, mode === "oracle" ? table.trim().toUpperCase() : table.trim());
  if (!schema?.trim()) {
    return quotedTable;
  }
  const normalizedSchema = mode === "oracle" ? schema.trim().toUpperCase() : schema.trim();
  return `${quoteIdentifier(mode, normalizedSchema)}.${quotedTable}`;
}

function quoteIdentifier(mode: CompatibilityMode, value: string): string {
  if (mode === "oracle") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `\`${value.replace(/`/g, "``")}\``;
}
