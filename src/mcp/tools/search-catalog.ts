import { z } from "zod";

import {
  listSchemas,
  searchCatalog
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  filterSchemas
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import { searchBusinessGlossary } from "../business-glossary.js";
import type { McpRequestContext } from "../context.js";
import { policyContext } from "../policy-context.js";
import {
  catalogSearchResult,
  dedupeSearchResults,
  glossarySearchResults,
  schemaSearchResult
} from "../search-results.js";
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

  registerTool(
    "ob_search_everything",
    {
      title: "Search OceanBase Metadata",
      description: "Search visible schemas, tables, columns, comments, and business glossary entries with confidence and evidence.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeGlossary: z.boolean().optional().default(true)
      }
    },
    async ({ profile, query, schema, limit, includeGlossary = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const maxResults = Math.min(limit ?? 30, 500);
      const schemaRows = filterSchemas(
        await withQuerySlot(selected, () =>
          listSchemas(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs)
        ),
        selected.config.policy
      );
      const catalogRows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          searchCatalog(
            selected.pool,
            selected.config.compatibility,
            query,
            schema,
            maxResults,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const glossary = includeGlossary
        ? searchBusinessGlossary(selected.config, query, maxResults, schema)
        : { configured: Boolean(selected.config.businessGlossary), matches: [], policyFiltered: false, warnings: [] };
      const results = dedupeSearchResults([
        ...schemaRows.flatMap((row) => schemaSearchResult(row, query, selected.config, schema)),
        ...catalogRows.flatMap((row) => catalogSearchResult(row, query, selected.config)),
        ...glossary.matches.flatMap((match) => glossarySearchResults(match, query))
      ])
        .sort((left, right) => right.confidence - left.confidence || left.type.localeCompare(right.type))
        .slice(0, maxResults);

      return toLimitedResult(
        {
          query,
          schema: schema ?? null,
          count: results.length,
          truncated: results.length >= maxResults,
          glossaryConfigured: glossary.configured,
          policyFiltered: glossary.policyFiltered,
          results,
          warnings: glossary.warnings
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_search_business_glossary",
    {
      title: "Search Business Glossary",
      description: "Search optional business terms mapped to allowed OceanBase schemas, tables, and columns.",
      inputSchema: {
        ...profileInput,
        query: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(500).optional()
      }
    },
    async ({ profile, query, schema, limit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      return toLimitedResult(
        searchBusinessGlossary(selected.config, query, Math.min(limit ?? 20, 500), schema),
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
