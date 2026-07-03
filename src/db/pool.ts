import mysql from "mysql2/promise";

import type { ObConfig } from "../config.js";
import { oracleTimeoutHint } from "./dialect/oracle.js";
import type { ObPool } from "./types.js";

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
