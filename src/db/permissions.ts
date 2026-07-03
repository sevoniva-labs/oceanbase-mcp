import type { CompatibilityMode } from "../config.js";
import { oracleTimeoutHint } from "./dialect/oracle.js";
import type { ObPool, PermissionVerification } from "./types.js";

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
