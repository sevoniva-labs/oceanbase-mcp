import { z } from "zod";

import {
  findColumns,
  findRelatedTables,
  listSchemas,
  searchCatalog
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  filterSchemas,
  isSchemaAllowed
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import { searchBusinessGlossary } from "../business-glossary.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  catalogSearchResult,
  columnSearchRows,
  dedupeColumnSearchResults,
  dedupeSearchResults,
  glossaryColumnRows,
  glossarySearchResults,
  relatedTableEvidence,
  schemaSearchResult,
  tableCandidatesFromSearchResults,
  type BusinessTableCandidate
} from "../search-results.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { isRelationshipAllowed } from "./schema-map.js";

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
    "ob_find_tables_by_business_term",
    {
      title: "Find Tables by Business Term",
      description: "Find visible candidate tables from a business term using glossary, catalog metadata, comments, and relationship evidence.",
      inputSchema: {
        ...profileInput,
        term: z.string().min(1),
        schema: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        includeRelated: z.boolean().optional().default(true),
        relationshipLimit: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, term, schema, limit, includeRelated = true, relationshipLimit }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      if (schema) {
        assertTableAccess(schema, "*", policyContext(selected.config));
      }
      const maxResults = Math.min(limit ?? 20, 100);
      const catalogRows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          searchCatalog(
            selected.pool,
            selected.config.compatibility,
            term,
            schema,
            maxResults,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const glossary = searchBusinessGlossary(selected.config, term, maxResults, schema);
      const searchResults = dedupeSearchResults([
        ...catalogRows.flatMap((row) => catalogSearchResult(row, term, selected.config)),
        ...glossary.matches.flatMap((match) => glossarySearchResults(match, term))
      ]);
      const candidates = tableCandidatesFromSearchResults(searchResults, selected.config, maxResults);
      if (includeRelated) {
        await attachRelatedTablesToCandidates(
          selected,
          candidates,
          Math.min(relationshipLimit ?? 8, 50)
        );
      }

      return toLimitedResult(
        {
          term,
          schema: schema ?? null,
          count: candidates.length,
          glossaryConfigured: glossary.configured,
          policyFiltered: glossary.policyFiltered,
          candidates,
          warnings: glossary.warnings
        },
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

  registerTool(
    "ob_find_columns",
    {
      title: "Find Columns",
      description: "Find visible columns across tables by name, comment, data type, table pattern, or business term.",
      inputSchema: {
        ...profileInput,
        query: z.string().optional(),
        schema: z.string().optional(),
        tablePattern: z.string().optional(),
        dataType: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeGlossary: z.boolean().optional().default(true)
      }
    },
    async ({ profile, query, schema, tablePattern, dataType, limit, includeGlossary = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      const maxResults = Math.min(limit ?? 50, 500);
      const rows = filterColumnMetadata(
        await withQuerySlot(selected, () =>
          findColumns(
            selected.pool,
            selected.config.compatibility,
            { query, schema: effectiveSchema, tablePattern, dataType },
            maxResults,
            selected.config.queryTimeoutMs
          )
        ),
        selected.config.policy
      );
      const columns = rows.flatMap((row) =>
        columnSearchRows(row, query, dataType, selected.config)
      );
      const glossary = includeGlossary && query
        ? searchBusinessGlossary(selected.config, query, maxResults, effectiveSchema)
        : { configured: Boolean(selected.config.businessGlossary), matches: [], policyFiltered: false, warnings: [] };
      const glossaryColumns = glossary.matches.flatMap((match) =>
        glossaryColumnRows(match, query ?? "", selected.config)
      );
      const results = dedupeColumnSearchResults([...columns, ...glossaryColumns])
        .sort((left, right) => right.confidence - left.confidence || left.column.localeCompare(right.column))
        .slice(0, maxResults);

      return toLimitedResult(
        {
          query: query ?? null,
          schema: effectiveSchema ?? null,
          tablePattern: tablePattern ?? null,
          dataType: dataType ?? null,
          count: results.length,
          truncated: rows.length >= maxResults,
          glossaryConfigured: glossary.configured,
          policyFiltered: glossary.policyFiltered,
          columns: results,
          warnings: glossary.warnings
        },
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

async function attachRelatedTablesToCandidates(
  selected: ReturnType<typeof selectAuthorizedProfile>,
  candidates: BusinessTableCandidate[],
  relationshipLimit: number
): Promise<void> {
  for (const candidate of candidates.slice(0, 10)) {
    const relationships = await withQuerySlot(selected, () =>
      findRelatedTables(
        selected.pool,
        selected.config.compatibility,
        candidate.table,
        candidate.schema,
        1,
        relationshipLimit,
        selected.config.queryTimeoutMs
      )
    );
    const related = relationships.relations
      .filter((relation) => isRelationshipAllowed(relation, selected.config))
      .map((relation) => relatedTableEvidence(candidate, relation, selected.config.compatibility))
      .filter((item): item is NonNullable<BusinessTableCandidate["relatedTables"]>[number] => Boolean(item))
      .slice(0, relationshipLimit);
    if (related.length > 0) {
      candidate.relatedTables = related;
    }
  }
}
