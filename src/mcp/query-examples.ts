import type { ObConfig } from "../config.js";
import { generateQueryTemplates, type QueryTemplateScenario } from "../query-generation.js";

import { explainGeneratedQuery } from "./sql-policy-explain.js";

export function queryExampleFromTemplate(
  template: ReturnType<typeof generateQueryTemplates>["templates"][number],
  config: ObConfig
) {
  return {
    scenario: template.scenario,
    title: template.title,
    purpose: queryExamplePurpose(template.scenario),
    sql: template.sql,
    parameters: template.parameters.map((parameter) => ({
      ...parameter,
      exampleValue: queryExampleParameterValue(parameter.name, parameter.type, config)
    })),
    policy: explainGeneratedQuery(template.sql, template.parameters.length, config),
    recommendedWorkflow: queryExampleWorkflow(template.scenario),
    notes: template.notes,
    executed: false
  };
}

function queryExamplePurpose(scenario: QueryTemplateScenario): string {
  const purposes: Record<QueryTemplateScenario, string> = {
    by_primary_key: "Read one row by a key column.",
    pagination: "Inspect rows in bounded pages.",
    time_range: "Read rows within a bounded time range.",
    aggregation: "Count rows or groups for quick data understanding.",
    join: "Inspect rows with a related table using visible relationship evidence."
  };
  return purposes[scenario];
}

function queryExampleWorkflow(scenario: QueryTemplateScenario): string[] {
  const workflow = [
    "Review the visible metadata and policy result before using the SQL.",
    "Run ob_lint_sql or ob_query_preview before executing the query.",
    "Bind parameters explicitly; do not inline user input."
  ];
  if (scenario === "pagination") {
    workflow.push("For repeated browsing, prefer ob_query_page with a stable order.");
  }
  return workflow;
}

function queryExampleParameterValue(name: string, type: string | undefined, config: ObConfig): unknown {
  const normalized = name.toLowerCase();
  if (normalized === "limit") {
    return Math.min(config.maxRows, 50);
  }
  if (normalized === "offset") {
    return 0;
  }
  if (normalized.includes("start") && normalized.includes("time")) {
    return "YYYY-MM-DD 00:00:00";
  }
  if (normalized.includes("end") && normalized.includes("time")) {
    return "YYYY-MM-DD 23:59:59";
  }
  if (/\b(number|int|decimal|numeric|bigint)\b/i.test(type ?? "")) {
    return 1;
  }
  return `<${name}>`;
}
