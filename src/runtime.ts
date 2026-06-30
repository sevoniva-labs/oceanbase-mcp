import type { GatewayConfig, ObConfig } from "./config.js";
import { createObPool, type ObPool } from "./db.js";

export interface GatewayRuntime {
  defaultProfile: string;
  configs: Record<string, ObConfig>;
  pools: Record<string, ObPool>;
  queryLimiters: Record<string, QueryLimiter>;
}

interface QueryLimiter {
  active: number;
  limit: number;
}

export function createGatewayRuntime(config: GatewayConfig): GatewayRuntime {
  const pools: Record<string, ObPool> = {};
  const queryLimiters: Record<string, QueryLimiter> = {};
  for (const [profile, profileConfig] of Object.entries(config.profiles)) {
    pools[profile] = createObPool(profileConfig);
    queryLimiters[profile] = {
      active: 0,
      limit: profileConfig.maxConcurrentQueries
    };
  }

  return {
    defaultProfile: config.defaultProfile,
    configs: config.profiles,
    pools,
    queryLimiters
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
} {
  const selected = profile?.trim() || runtime.defaultProfile;
  const config = runtime.configs[selected];
  const pool = runtime.pools[selected];
  const limiter = runtime.queryLimiters[selected];
  if (!config || !pool || !limiter) {
    throw new Error(`Unknown OceanBase MCP profile "${selected}".`);
  }
  return { profile: selected, config, pool, limiter };
}

export async function withQuerySlot<T>(
  selected: ReturnType<typeof selectRuntimeProfile>,
  operation: () => Promise<T>
): Promise<T> {
  if (selected.limiter.active >= selected.limiter.limit) {
    throw new Error(
      `Profile "${selected.profile}" has reached OB_MAX_CONCURRENT_QUERIES=${selected.limiter.limit}.`
    );
  }

  selected.limiter.active += 1;
  try {
    return await operation();
  } finally {
    selected.limiter.active -= 1;
  }
}
