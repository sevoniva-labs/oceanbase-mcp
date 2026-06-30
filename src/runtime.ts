import type { GatewayConfig, ObConfig } from "./config.js";
import { createObPool, type ObPool } from "./db.js";

export interface GatewayRuntime {
  defaultProfile: string;
  configs: Record<string, ObConfig>;
  pools: Record<string, ObPool>;
}

export function createGatewayRuntime(config: GatewayConfig): GatewayRuntime {
  const pools: Record<string, ObPool> = {};
  for (const [profile, profileConfig] of Object.entries(config.profiles)) {
    pools[profile] = createObPool(profileConfig);
  }

  return {
    defaultProfile: config.defaultProfile,
    configs: config.profiles,
    pools
  };
}

export async function closeGatewayRuntime(runtime: GatewayRuntime): Promise<void> {
  await Promise.all(Object.values(runtime.pools).map((pool) => pool.end()));
}

export function selectRuntimeProfile(runtime: GatewayRuntime, profile?: string): {
  profile: string;
  config: ObConfig;
  pool: ObPool;
} {
  const selected = profile?.trim() || runtime.defaultProfile;
  const config = runtime.configs[selected];
  const pool = runtime.pools[selected];
  if (!config || !pool) {
    throw new Error(`Unknown OceanBase MCP profile "${selected}".`);
  }
  return { profile: selected, config, pool };
}
