import { AsyncLocalStorage } from "node:async_hooks";

import type { GatewayConfig, ObConfig } from "./config.js";
import { createObPool, type ObPool } from "./db.js";

export interface GatewayRuntime {
  defaultProfile: string;
  configs: Record<string, ObConfig>;
  pools: Record<string, ObPool>;
  queryLimiters: Record<string, QueryLimiter>;
  metadataCaches: Record<string, MetadataCacheStore>;
}

export interface QueryLimiter {
  active: number;
  limit: number;
}

export interface MetadataCacheStore {
  entries: Map<string, MetadataCacheEntry>;
  hits: number;
  misses: number;
  evictions: number;
}

export interface ExecutionDiagnostics {
  dbCalls: number;
  maxDbCalls: number | null;
  toolName?: string;
  deadlineMs?: number;
}

interface MetadataCacheEntry {
  value: unknown;
  createdAt: number;
  expiresAt: number;
}

const executionDiagnosticsStore = new AsyncLocalStorage<ExecutionDiagnostics>();

export function createGatewayRuntime(config: GatewayConfig): GatewayRuntime {
  const pools: Record<string, ObPool> = {};
  const queryLimiters: Record<string, QueryLimiter> = {};
  const metadataCaches: Record<string, MetadataCacheStore> = {};
  for (const [profile, profileConfig] of Object.entries(config.profiles)) {
    pools[profile] = createObPool(profileConfig);
    queryLimiters[profile] = {
      active: 0,
      limit: profileConfig.maxConcurrentQueries
    };
    metadataCaches[profile] = createMetadataCacheStore();
  }

  return {
    defaultProfile: config.defaultProfile,
    configs: config.profiles,
    pools,
    queryLimiters,
    metadataCaches
  };
}

export async function closeGatewayRuntime(runtime: GatewayRuntime): Promise<void> {
  await Promise.all(Object.values(runtime.pools).map((pool) => pool.end()));
}

export function selectRuntimeProfile(runtime: GatewayRuntime, profile?: string): {
  profile: string;
  config: ObConfig;
  pool: ObPool;
  limiter: QueryLimiter;
  metadataCache: MetadataCacheStore;
} {
  const selected = profile?.trim() || runtime.defaultProfile;
  const config = runtime.configs[selected];
  const pool = runtime.pools[selected];
  const limiter = runtime.queryLimiters[selected];
  if (!config || !pool || !limiter) {
    throw new Error(`Unknown OceanBase MCP profile "${selected}".`);
  }
  runtime.metadataCaches ??= {};
  runtime.metadataCaches[selected] ??= createMetadataCacheStore();
  return { profile: selected, config, pool, limiter, metadataCache: runtime.metadataCaches[selected] };
}

export async function withQuerySlot<T>(
  selected: ReturnType<typeof selectRuntimeProfile>,
  operation: () => Promise<T>
): Promise<T> {
  const diagnostics = executionDiagnosticsStore.getStore();
  if (diagnostics?.deadlineMs != null && Date.now() > diagnostics.deadlineMs) {
    throw new Error(
      `Tool "${diagnostics.toolName ?? "unknown"}" exceeded configured timeout budget before starting another database operation. Narrow schema, table scope, page size, or ER export window before retrying.`
    );
  }

  if (selected.limiter.active >= selected.limiter.limit) {
    throw new Error(
      `Profile "${selected.profile}" has reached OB_MAX_CONCURRENT_QUERIES=${selected.limiter.limit}.`
    );
  }

  if (diagnostics) {
    diagnostics.dbCalls += 1;
    if (diagnostics.maxDbCalls != null && diagnostics.dbCalls > diagnostics.maxDbCalls) {
      throw new Error(
        `Tool "${diagnostics.toolName ?? "unknown"}" exceeded DB call budget maxDbCalls=${diagnostics.maxDbCalls}. Narrow schema, table scope, page size, or ER export window before retrying.`
      );
    }
  }
  selected.limiter.active += 1;
  try {
    return await operation();
  } finally {
    selected.limiter.active -= 1;
  }
}

export function createExecutionDiagnostics(
  maxDbCalls: number | null = null,
  toolName?: string,
  deadlineMs?: number
): ExecutionDiagnostics {
  return {
    dbCalls: 0,
    maxDbCalls,
    toolName,
    deadlineMs
  };
}

export function withExecutionDiagnostics<T>(
  diagnostics: ExecutionDiagnostics,
  operation: () => Promise<T>
): Promise<T> {
  return executionDiagnosticsStore.run(diagnostics, operation);
}

export async function withMetadataCache<T>(
  selected: ReturnType<typeof selectRuntimeProfile>,
  namespace: string,
  parts: unknown[],
  operation: () => Promise<T>
): Promise<T> {
  if (!selected.config.metadataCacheEnabled || selected.config.metadataCacheTtlMs <= 0 || selected.config.metadataCacheMaxEntries <= 0) {
    return operation();
  }
  const now = Date.now();
  const key = metadataCacheKey(namespace, parts);
  const entry = selected.metadataCache.entries.get(key);
  if (entry && entry.expiresAt > now) {
    selected.metadataCache.hits += 1;
    return entry.value as T;
  }
  if (entry) {
    selected.metadataCache.entries.delete(key);
  }
  selected.metadataCache.misses += 1;
  const value = await operation();
  selected.metadataCache.entries.set(key, {
    value,
    createdAt: now,
    expiresAt: now + selected.config.metadataCacheTtlMs
  });
  pruneMetadataCache(selected.metadataCache, selected.config.metadataCacheMaxEntries);
  return value;
}

function createMetadataCacheStore(): MetadataCacheStore {
  return {
    entries: new Map(),
    hits: 0,
    misses: 0,
    evictions: 0
  };
}

function metadataCacheKey(namespace: string, parts: unknown[]): string {
  return JSON.stringify([namespace, ...parts]);
}

function pruneMetadataCache(store: MetadataCacheStore, maxEntries: number): void {
  while (store.entries.size > maxEntries) {
    const oldestKey = store.entries.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    store.entries.delete(oldestKey);
    store.evictions += 1;
  }
}
