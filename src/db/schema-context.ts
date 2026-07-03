import type { CompatibilityMode } from "../config.js";
import { oracleTimeoutHint } from "./dialect/oracle.js";
import type { ObPool } from "./types.js";

export async function currentMysqlSchema(pool: ObPool, timeoutMs: number): Promise<string | undefined> {
  const [rows] = await pool.query({ sql: "SELECT DATABASE() AS schema_name", timeout: timeoutMs });
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const value = first?.schema_name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function currentOracleSchema(pool: ObPool, timeoutMs: number): Promise<string | undefined> {
  const [rows] = await pool.query({ sql: `SELECT ${oracleTimeoutHint(timeoutMs)} USER AS schema_name FROM DUAL`, timeout: timeoutMs });
  const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const value = first?.schema_name ?? first?.SCHEMA_NAME;
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined;
}

export async function isCurrentOracleSchema(pool: ObPool, schema: string | undefined, timeoutMs: number): Promise<boolean> {
  const current = await currentOracleSchema(pool, timeoutMs);
  return !schema || (!!current && schema.trim().toUpperCase() === current);
}

export function qualifiedTableName(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  const quotedTable = quoteIdentifier(mode, mode === "oracle" ? table.trim().toUpperCase() : table.trim());
  if (!schema?.trim()) {
    return quotedTable;
  }
  const normalizedSchema = mode === "oracle" ? schema.trim().toUpperCase() : schema.trim();
  return `${quoteIdentifier(mode, normalizedSchema)}.${quotedTable}`;
}

export function quoteIdentifier(mode: CompatibilityMode, value: string): string {
  if (mode === "oracle") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `\`${value.replace(/`/g, "``")}\``;
}
