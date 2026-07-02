import type { AuthPrincipal, GatewayConfig, ObConfig } from "../config.js";
import { publicConfig } from "../config.js";
import { selectRuntimeProfile, type GatewayRuntime } from "../runtime.js";
import type { McpRequestContext } from "./context.js";

export function selectAuthorizedProfile(runtime: GatewayRuntime, profile: string | undefined, context: McpRequestContext) {
  const selected = selectRuntimeProfile(runtime, profile?.trim() || visibleDefaultProfile(runtime, context));
  assertProfileAllowed(selected.profile, context.principal);
  return selected;
}

export function assertToolAllowed(tool: string, principal: AuthPrincipal | undefined): void {
  if (!isToolAllowed(tool, principal)) {
    throw new Error(`Tool "${tool}" is not allowed for token "${principal?.name ?? "unknown"}".`);
  }
}

export function isToolAllowed(tool: string, principal: AuthPrincipal | undefined): boolean {
  return !principal?.tools || principal.tools.length === 0 || principal.tools.includes(tool);
}

export function visibleDefaultProfile(runtime: GatewayRuntime, context: McpRequestContext): string {
  if (isProfileVisible(runtime.defaultProfile, context.principal)) {
    return runtime.defaultProfile;
  }
  const firstVisible = Object.keys(runtime.configs).find((profile) => isProfileVisible(profile, context.principal));
  if (!firstVisible) {
    throw new Error(`No OceanBase MCP profile is allowed for token "${context.principal?.name ?? "unknown"}".`);
  }
  return firstVisible;
}

export function publicProfiles(runtime: GatewayRuntime, context: McpRequestContext) {
  return Object.fromEntries(
    Object.entries(runtime.configs)
      .filter(([name]) => isProfileVisible(name, context.principal))
      .map(([name, config]) => [name, publicConfig(config)])
  );
}

export function authorizedGatewayConfig(runtime: GatewayRuntime, context: McpRequestContext): GatewayConfig {
  return {
    defaultProfile: visibleDefaultProfile(runtime, context),
    profiles: Object.fromEntries(
      Object.entries(runtime.configs).filter(([name]) => isProfileVisible(name, context.principal))
    )
  };
}

export function gatewayLimitConfig(runtime: GatewayRuntime, context: McpRequestContext): ObConfig {
  return runtime.configs[visibleDefaultProfile(runtime, context)];
}

function assertProfileAllowed(profile: string, principal: AuthPrincipal | undefined): void {
  if (!principal?.profiles || principal.profiles.length === 0) {
    return;
  }
  if (!principal.profiles.includes(profile)) {
    throw new Error(`Profile "${profile}" is not allowed for token "${principal.name}".`);
  }
}

function isProfileVisible(profile: string, principal: AuthPrincipal | undefined): boolean {
  return !principal?.profiles || principal.profiles.length === 0 || principal.profiles.includes(profile);
}
