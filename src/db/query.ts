import type { FieldPacket, QueryResult } from "mysql2/promise";

import type { CompatibilityMode } from "../config.js";
import { rowsToOutput, type QueryOutput } from "../format.js";
import { timeoutMicros } from "./dialect/oracle.js";
import { normalizeSqlForDriver } from "./sql-driver.js";
import type { ObConnection, ObPool, SqlParam } from "./types.js";

export async function runQuery(
  pool: ObPool,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  timeoutMs: number,
  maxOutputBytes = Number.POSITIVE_INFINITY
): Promise<QueryOutput> {
  const [result, fields] = await pool.query({ sql, values: params, timeout: timeoutMs });
  return rowsToOutput(result as QueryResult, fields as FieldPacket[] | undefined, maxRows, maxOutputBytes);
}

export async function runReadOnlyQuery(
  pool: ObPool,
  mode: CompatibilityMode,
  sql: string,
  params: SqlParam[],
  maxRows: number,
  timeoutMs: number,
  enforceReadOnlyTransaction: boolean,
  maxOutputBytes = Number.POSITIVE_INFINITY
): Promise<QueryOutput> {
  const driverSql = normalizeSqlForDriver(mode, sql, params);
  if (!enforceReadOnlyTransaction) {
    return runQuery(pool, driverSql, params, maxRows, timeoutMs, maxOutputBytes);
  }

  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await setOceanBaseQueryTimeout(connection, timeoutMs);
    const readOnlySql = mode === "oracle" ? "SET TRANSACTION READ ONLY" : "START TRANSACTION READ ONLY";
    await connection.query({ sql: readOnlySql, timeout: timeoutMs });
    transactionStarted = true;
    const [result, fields] = await connection.query({ sql: driverSql, values: params, timeout: timeoutMs });
    await connection.query({ sql: "ROLLBACK", timeout: timeoutMs });
    transactionStarted = false;
    return rowsToOutput(result as QueryResult, fields as FieldPacket[] | undefined, maxRows, maxOutputBytes);
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
