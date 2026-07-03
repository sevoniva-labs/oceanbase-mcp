import { z } from "zod";

import { searchCatalog } from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import { searchBusinessGlossary } from "../business-glossary.js";
import type { McpRequestContext } from "../context.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerSearchCatalogTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_search_catalog",
    {
      title: "Search Catalog",
      description: "Search schemas, tables, columns, and comments, filtered by access policy.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional()
      }
    },
    async ({ profile, query, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const maxResults = effectiveRowLimit(limit, selected.config);
      const rows = await withQuerySlot(selected, () =>
        searchCatalog(
          selected.pool,
          selected.config.compatibility,
          query,
          schema,
          maxResults,
          selected.config.queryTimeoutMs
        )
      );
      const catalogRows = filterColumnMetadata(rows, selected.config.policy);
      const glossary = searchBusinessGlossary(selected.config, query, maxResults, schema);
      return toLimitedResult(
        [...glossary.matches.map(glossaryCatalogRow), ...catalogRows].slice(0, maxResults),
        selected.config
      );
    }
  );
}

function glossaryCatalogRow(match: {
  term: string;
  aliases: string[];
  description?: string;
  targets: unknown[];
  evidence: string[];
}) {
  return {
    match_type: "business_glossary",
    source: "business_glossary",
    term: match.term,
    aliases: match.aliases,
    description: match.description,
    targets: match.targets,
    evidence: match.evidence
  };
}
