import { z } from "zod";

import type { ObConfig } from "../../config.js";
import { explainSqlPolicy } from "../../policy.js";
import { assertReadOnlySql, assertSqlInputLimits } from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { policyContext } from "../policy-context.js";
import { compatibilityModeSchema, profileInput } from "../schemas.js";
import { runExplainCheck } from "../sql-policy-explain.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import type { GatewayRuntime } from "../../runtime.js";

export function registerSqlConversionTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_convert_sql_dialect",
    {
      title: "Convert SQL Dialect",
      description: "Convert read-only SQL between OceanBase MySQL and Oracle modes with documented limitations.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        targetMode: compatibilityModeSchema,
        sourceMode: compatibilityModeSchema.optional()
      }
    },
    async ({ profile, sql, targetMode, sourceMode }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const converted = convertSqlDialect(selected.config, sql, sourceMode ?? selected.config.compatibility, targetMode);
      return toLimitedResult(converted, selected.config);
    }
  );
}

function convertSqlDialect(
  config: ObConfig,
  sql: string,
  sourceMode: ObConfig["compatibility"],
  targetMode: ObConfig["compatibility"]
) {
  const checks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, [], config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  if (!checks.every((check) => check.ok)) {
    return {
      sql,
      convertedSql: null,
      sourceMode,
      targetMode,
      changed: false,
      checks,
      warnings: ["SQL was not converted because it did not pass read-only input checks."],
      limitations: []
    };
  }
  if (sourceMode === targetMode) {
    return {
      sql,
      convertedSql: trimConversionSql(sql),
      sourceMode,
      targetMode,
      changed: false,
      checks,
      policy: explainSqlPolicy(sql, policyContext(config)),
      warnings: ["Source and target modes are the same; SQL was normalized only."],
      limitations: []
    };
  }

  const warnings = [
    "Review converted SQL before use; function behavior and date arithmetic may not be fully equivalent."
  ];
  const limitations: string[] = [];
  let convertedSql = trimConversionSql(sql);
  if (sourceMode === "mysql" && targetMode === "oracle") {
    convertedSql = convertedSql.replace(/`([^`]+)`/g, (_match, name: string) => `"${name.replace(/"/g, "\"\"").toUpperCase()}"`);
    convertedSql = convertedSql.replace(/\bIFNULL\s*\(/gi, "NVL(");
    convertedSql = convertedSql.replace(/\bNOW\s*\(\s*\)/gi, "SYSTIMESTAMP");
    convertedSql = convertedSql.replace(/\bCURDATE\s*\(\s*\)/gi, "TRUNC(SYSDATE)");
    convertedSql = convertLimitToOracle(convertedSql);
    if (/\bdate_format\s*\(/i.test(sql)) {
      limitations.push("DATE_FORMAT was not converted; rewrite it manually with TO_CHAR.");
    }
  } else {
    convertedSql = convertedSql.replace(/"([A-Za-z_][\w$]*)"/g, (_match, name: string) => `\`${name}\``);
    convertedSql = convertedSql.replace(/\bNVL\s*\(/gi, "IFNULL(");
    convertedSql = convertedSql.replace(/\bSYSTIMESTAMP\b/gi, "NOW()");
    convertedSql = convertedSql.replace(/\bSYSDATE\b/gi, "NOW()");
    convertedSql = convertFetchToMysql(convertedSql);
    convertedSql = convertSimpleRownumToMysql(convertedSql, limitations);
    if (/\bto_char\s*\(/i.test(sql)) {
      limitations.push("TO_CHAR was not converted; rewrite it manually with DATE_FORMAT if needed.");
    }
  }
  const outputChecks = [
    runExplainCheck("converted_read_only_sql", () => assertReadOnlySql(convertedSql))
  ];
  const policy = explainSqlPolicy(convertedSql, policyContext(config));
  return {
    sql,
    convertedSql,
    sourceMode,
    targetMode,
    changed: convertedSql !== trimConversionSql(sql),
    checks: [...checks, ...outputChecks],
    policy,
    allowed: outputChecks.every((check) => check.ok) && policy.allowed,
    warnings,
    limitations,
    executed: false
  };
}

function convertLimitToOracle(sql: string): string {
  let output = sql.replace(/\s+limit\s+(\d+)\s+offset\s+(\d+)\s*$/i, (_match, limit: string, offset: string) =>
    ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  );
  output = output.replace(/\s+limit\s+(\d+)\s*$/i, (_match, limit: string) =>
    ` FETCH FIRST ${limit} ROWS ONLY`
  );
  return output;
}

function convertFetchToMysql(sql: string): string {
  let output = sql.replace(/\s+offset\s+(\d+)\s+rows\s+fetch\s+next\s+(\d+)\s+rows\s+only\s*$/i, (_match, offset: string, limit: string) =>
    ` LIMIT ${limit} OFFSET ${offset}`
  );
  output = output.replace(/\s+fetch\s+first\s+(\d+)\s+rows\s+only\s*$/i, (_match, limit: string) =>
    ` LIMIT ${limit}`
  );
  return output;
}

function convertSimpleRownumToMysql(sql: string, limitations: string[]): string {
  const converted = sql.replace(/\s+where\s+rownum\s*<=\s*(\d+)\s*$/i, (_match, limit: string) => ` LIMIT ${limit}`);
  if (converted === sql && /\brownum\b/i.test(sql)) {
    limitations.push("ROWNUM predicates were not fully converted; use LIMIT/OFFSET manually.");
  }
  return converted;
}

function trimConversionSql(sql: string): string {
  return sql.trim().replace(/;+$/, "").trimEnd();
}
