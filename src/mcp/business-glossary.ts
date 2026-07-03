import type { ObConfig } from "../config.js";
import {
  assertTableAccess,
  isDeniedColumn,
  isSchemaAllowed
} from "../policy.js";

import { metadataSchema } from "./metadata-scope.js";
import { policyContext } from "./policy-context.js";

export function searchBusinessGlossary(
  config: ObConfig,
  query: string,
  limit: number,
  schemaFilter?: string
) {
  const glossary = config.businessGlossary;
  const maxResults = Math.max(1, Math.min(limit, 500));
  if (!glossary) {
    return {
      configured: false,
      query,
      matches: [],
      policyFiltered: false,
      warnings: ["No business glossary is configured."]
    };
  }

  const matches = [];
  let policyFiltered = false;
  for (const entry of glossary.entries) {
    if (!businessGlossaryEntryMatches(entry, query)) {
      continue;
    }
    const targets = visibleGlossaryTargets(config, entry.targets, schemaFilter);
    if (targets.policyFiltered) {
      policyFiltered = true;
    }
    if (targets.visible.length === 0) {
      continue;
    }
    matches.push({
      term: entry.term,
      aliases: entry.aliases,
      description: entry.description,
      targets: targets.visible,
      evidence: businessGlossaryEvidence(entry, query)
    });
    if (matches.length >= maxResults) {
      break;
    }
  }

  return {
    configured: true,
    query,
    matches,
    policyFiltered,
    warnings: policyFiltered ? ["Some glossary targets were hidden by the active MCP access policy."] : []
  };
}

export function visibleGlossaryTargets(
  config: ObConfig,
  targets: NonNullable<ObConfig["businessGlossary"]>["entries"][number]["targets"],
  schemaFilter?: string
) {
  const visible = [];
  let policyFiltered = false;
  for (const target of targets) {
    const schema = metadataSchema(config, target.schema ?? schemaFilter);
    if (schemaFilter && schema && normalizeGlossaryText(schema) !== normalizeGlossaryText(schemaFilter)) {
      policyFiltered = true;
      continue;
    }
    if (!glossaryTargetAllowed(config, schema, target.table, target.column)) {
      policyFiltered = true;
      continue;
    }
    visible.push({
      schema,
      table: target.table,
      column: target.column,
      description: target.description
    });
  }
  return { visible, policyFiltered };
}

export function normalizeGlossaryText(value: string): string {
  return value.trim().toLowerCase();
}

function businessGlossaryEntryMatches(
  entry: NonNullable<ObConfig["businessGlossary"]>["entries"][number],
  query: string
): boolean {
  const needle = normalizeGlossaryText(query);
  const haystack = [
    entry.term,
    entry.description,
    ...entry.aliases,
    ...entry.targets.flatMap((target) => [target.schema, target.table, target.column, target.description])
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(normalizeGlossaryText);
  return haystack.some((value) => value.includes(needle) || needle.includes(value));
}

function businessGlossaryEvidence(
  entry: NonNullable<ObConfig["businessGlossary"]>["entries"][number],
  query: string
): string[] {
  const needle = normalizeGlossaryText(query);
  const evidence: string[] = [];
  if (normalizeGlossaryText(entry.term).includes(needle) || needle.includes(normalizeGlossaryText(entry.term))) {
    evidence.push("term");
  }
  for (const alias of entry.aliases) {
    if (normalizeGlossaryText(alias).includes(needle) || needle.includes(normalizeGlossaryText(alias))) {
      evidence.push(`alias:${alias}`);
    }
  }
  for (const target of entry.targets) {
    for (const value of [target.schema, target.table, target.column]) {
      if (value && (normalizeGlossaryText(value).includes(needle) || needle.includes(normalizeGlossaryText(value)))) {
        evidence.push(`target:${value}`);
      }
    }
  }
  return [...new Set(evidence)].slice(0, 10);
}

function glossaryTargetAllowed(
  config: ObConfig,
  schema: string | undefined,
  table: string | undefined,
  column: string | undefined
): boolean {
  if (column && isDeniedColumn(column, config.policy)) {
    return false;
  }
  if (table) {
    try {
      assertTableAccess(schema, table, policyContext(config));
      return true;
    } catch {
      return false;
    }
  }
  return schema != null && isSchemaAllowed(schema, config.policy);
}
