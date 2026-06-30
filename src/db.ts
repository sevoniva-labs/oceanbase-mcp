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
                 data_scale, nullable, column_id
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
               data_scale, nullable, column_id
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
