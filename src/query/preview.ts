import type { ObConfig } from "../config.js";
import { SENSITIVE_SAMPLE_PATTERN } from "../sensitive.js";

export function queryShape(sql: string, mode: ObConfig["compatibility"]) {
  return {
    hasRowLimit: hasSqlRowLimit(sql, mode),
    hasOrderBy: /\border\s+by\b/i.test(sql),
    hasWhere: /\bwhere\b/i.test(sql),
    hasJoin: /\bjoin\b/i.test(sql)
  };
}

export function hasSqlRowLimit(sql: string, mode: ObConfig["compatibility"]): boolean {
  if (/\blimit\s+\d+/i.test(sql) || /\bfetch\s+first\s+\d+\s+rows\b/i.test(sql) || /\brownum\b/i.test(sql)) {
    return true;
  }
  return mode === "oracle" && /\boffset\s+\d+\s+rows\s+fetch\s+next\s+\d+\s+rows\b/i.test(sql);
}

export function sensitiveSqlTerms(sql: string, config: ObConfig) {
  const normalizedSql = sql.toLowerCase();
  const terms = new Set<string>();
  for (const match of sql.matchAll(/[A-Za-z_][\w$]*/g)) {
    const value = match[0];
    if (SENSITIVE_SAMPLE_PATTERN.test(value)) {
      terms.add(value);
    }
  }
  for (const pattern of [...config.policy.deniedColumns, ...config.policy.maskedColumns]) {
    for (const part of pattern.split(/[.*,\s]+/).filter(Boolean)) {
      if (part !== "*" && normalizedSql.includes(part.toLowerCase())) {
        terms.add(part);
      }
    }
  }
  return {
    detected: terms.size > 0,
    terms: [...terms].slice(0, 20)
  };
}

export function queryPreviewWarnings(
  shape: ReturnType<typeof queryShape>,
  sensitiveColumnRisk: ReturnType<typeof sensitiveSqlTerms>
): string[] {
  const warnings: string[] = [];
  if (!shape.hasRowLimit) {
    warnings.push("No row limit was detected. Prefer a paged query or an explicit row cap for data inspection.");
  }
  if (!shape.hasOrderBy) {
    warnings.push("No ORDER BY was detected. Result order may be unstable.");
  }
  if (sensitiveColumnRisk.detected) {
    warnings.push("The SQL references fields that look sensitive or are configured for masking.");
  }
  return warnings;
}
