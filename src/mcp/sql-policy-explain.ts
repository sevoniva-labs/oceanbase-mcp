import type { ObConfig } from "../config.js";
import { explainSqlPolicy } from "../policy.js";
import { assertReadOnlySql, assertSqlInputLimits } from "../sql.js";
import { policyContext } from "./policy-context.js";

export function runExplainCheck(name: string, check: () => void) {
  try {
    check();
    return { name, ok: true, message: "Allowed." };
  } catch (error) {
    return { name, ok: false, message: (error as Error).message };
  }
}

export function explainGeneratedQuery(sql: string, paramCount: number, config: ObConfig) {
  const params = Array.from({ length: paramCount }, () => null);
  const sqlChecks = [
    runExplainCheck("input_limits", () => assertSqlInputLimits(sql, params, config)),
    runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
  ];
  const policy = explainSqlPolicy(sql, policyContext(config));
  return {
    allowed: sqlChecks.every((check) => check.ok) && policy.allowed,
    checks: [...sqlChecks, ...policy.checks],
    tableRefs: policy.tableRefs
  };
}
