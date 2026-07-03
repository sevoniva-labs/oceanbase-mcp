import type { CompatibilityMode } from "../config.js";
import type { SqlParam } from "./types.js";

export function normalizeSqlForDriver(mode: CompatibilityMode, sql: string, params: SqlParam[]): string {
  if (mode !== "oracle" || params.length === 0 || !sql.includes(":")) {
    return sql;
  }
  return replaceOracleNamedPlaceholders(sql);
}

function replaceOracleNamedPlaceholders(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'") {
      const end = readQuoted(sql, index, "'", "''");
      output += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      const end = readQuoted(sql, index, '"', '""');
      output += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`") {
      const end = readQuoted(sql, index, "`", "``");
      output += sql.slice(index, end);
      index = end;
      continue;
    }
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      const stop = end === -1 ? sql.length : end + 1;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === ":" && sql[index - 1] !== ":" && next !== ":" && isOracleBindStart(next)) {
      let end = index + 2;
      while (end < sql.length && isOracleBindPart(sql[end])) {
        end += 1;
      }
      output += "?";
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function readQuoted(sql: string, start: number, quote: string, escapedQuote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql.startsWith(escapedQuote, index)) {
      index += escapedQuote.length;
      continue;
    }
    if (sql[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function isOracleBindStart(char: string | undefined): boolean {
  return char != null && /[A-Za-z_0-9]/.test(char);
}

function isOracleBindPart(char: string): boolean {
  return /[A-Za-z0-9_$#]/.test(char);
}
