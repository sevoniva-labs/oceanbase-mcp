import type { ObConfig } from "../config.js";
import type { MetadataCacheStore } from "../runtime.js";

export interface MetadataCacheProfile {
  profile: string;
  config: ObConfig;
  metadataCache: MetadataCacheStore;
}

export function refreshMetadataCache(
  selected: MetadataCacheProfile,
  schema: string | undefined,
  table: string | undefined
) {
  const before = selected.metadataCache.entries.size;
  let removed = 0;
  if (!schema && !table) {
    removed = before;
    selected.metadataCache.entries.clear();
  } else {
    for (const key of [...selected.metadataCache.entries.keys()]) {
      if (metadataCacheKeyMatches(selected.config.compatibility, key, schema, table)) {
        selected.metadataCache.entries.delete(key);
        removed += 1;
      }
    }
  }
  return {
    profile: selected.profile,
    mode: selected.config.compatibility,
    scope: {
      schema: schema ?? null,
      table: table ?? null
    },
    cacheEnabled: selected.config.metadataCacheEnabled,
    beforeEntries: before,
    removedEntries: removed,
    afterEntries: selected.metadataCache.entries.size,
    stats: metadataCacheStats(selected.metadataCache),
    executed: false,
    warnings: [
      "Only in-memory metadata cache entries for the selected profile are cleared.",
      "Query results and sample rows are not cached by the metadata cache."
    ]
  };
}

export function metadataCacheStatus(selected: MetadataCacheProfile) {
  const now = Date.now();
  const namespaceCounts = new Map<string, number>();
  let expiredEntries = 0;
  for (const [key, entry] of selected.metadataCache.entries) {
    const parsed = parseMetadataCacheKey(key);
    const namespace = parsed && typeof parsed[0] === "string" ? parsed[0] : "unknown";
    namespaceCounts.set(namespace, (namespaceCounts.get(namespace) ?? 0) + 1);
    if (entry.expiresAt <= now) {
      expiredEntries += 1;
    }
  }
  return {
    profile: selected.profile,
    mode: selected.config.compatibility,
    enabled: selected.config.metadataCacheEnabled,
    ttlMs: selected.config.metadataCacheTtlMs,
    maxEntries: selected.config.metadataCacheMaxEntries,
    entries: selected.metadataCache.entries.size,
    expiredEntries,
    namespaces: [...namespaceCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, count]) => ({ namespace, count })),
    stats: metadataCacheStats(selected.metadataCache),
    executed: false,
    warnings: [
      "Cache status reports counts only; cached metadata content is not returned.",
      "The metadata cache is in-memory and is cleared when the MCP process restarts."
    ]
  };
}

export function metadataCacheKeyMatches(
  mode: ObConfig["compatibility"],
  key: string,
  schema: string | undefined,
  table: string | undefined
): boolean {
  const parsed = parseMetadataCacheKey(key);
  if (!parsed) {
    return false;
  }
  const [namespace, , cachedSchema, cachedTable] = parsed;
  const schemaMatches = !schema || normalizeTableName(mode, String(cachedSchema ?? "")) === normalizeTableName(mode, schema);
  if (!schemaMatches) {
    return false;
  }
  if (!table) {
    return true;
  }
  if (namespace === "schema_map_tables") {
    return true;
  }
  return normalizeTableName(mode, String(cachedTable ?? "")) === normalizeTableName(mode, table);
}

function parseMetadataCacheKey(key: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function metadataCacheStats(metadataCache: MetadataCacheStore) {
  return {
    hits: metadataCache.hits,
    misses: metadataCache.misses,
    evictions: metadataCache.evictions
  };
}

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}
