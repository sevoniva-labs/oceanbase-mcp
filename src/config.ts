import { readFileSync } from "node:fs";

import { validateAllowedIpRules } from "./ip-policy.js";

export type CompatibilityMode = "mysql" | "oracle";

export interface ObSslConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized: boolean;
}

export interface AccessPolicy {
  allowedSchemas: string[];
  allowedTables: string[];
  deniedSchemas: string[];
  deniedTables: string[];
  deniedColumns: string[];
  allowSelectStar: boolean;
  includeSystemSchemas: boolean;
  requireAccessPolicy: boolean;
}

export interface ObConfig {
  profile: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  compatibility: CompatibilityMode;
  productionMode: boolean;
  mcpReadOnly: boolean;
  dbUserReadOnly: boolean;
  connectionLimit: number;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  maxRows: number;
  maxSqlLength: number;
  maxParamCount: number;
  enforceReadOnlyTransaction: boolean;
  requireTls: boolean;
  policy: AccessPolicy;
  ssl?: ObSslConfig;
}

export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  allowedHosts?: string[];
  allowedIps: string[];
  trustProxy: boolean;
  bodyLimit: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export interface GatewayConfig {
  defaultProfile: string;
  profiles: Record<string, ObConfig>;
}

export interface PublicObConfig
  extends Omit<ObConfig, "password" | "ssl"> {
  passwordConfigured: boolean;
  sslConfigured: boolean;
  sslRejectUnauthorized?: boolean;
}

const DEFAULT_CLUSTER = "obcluster";
const DEFAULT_TENANT = "ob_mysql";
const DEFAULT_USERNAME = "ob_user";
const DEFAULT_PROFILE = "default";
const DEFAULT_DENIED_SCHEMAS = ["information_schema", "mysql", "oceanbase", "performance_schema", "sys"];
const DEFAULT_DENIED_COLUMNS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "private_key",
  "credential",
  "credentials",
  "session",
  "cookie"
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env, profile = DEFAULT_PROFILE): ObConfig {
  const compatibility = parseCompatibility(env.OB_COMPATIBILITY ?? env.OB_MODE);
  const productionMode = parseBoolean(env.OB_PRODUCTION, false) || env.NODE_ENV === "production";
  const mcpReadOnly = parseBoolean(env.OB_MCP_READ_ONLY, true);
  const dbUserReadOnly = parseBoolean(env.OB_DB_USER_READ_ONLY, false);
  const user = resolveUser(env, productionMode);
  const password = resolvePassword(env, productionMode);
  const ssl = loadSslConfig(env);
  const requireTls = parseBoolean(env.OB_REQUIRE_TLS, false);
  const policy = loadAccessPolicy(env, productionMode);
  const enforceReadOnlyTransaction = parseBoolean(env.OB_ENFORCE_READ_ONLY_TX, true);
  if (requireTls && !ssl) {
    throw new Error("OB_REQUIRE_TLS=true but no OB_SSL_* certificate material was configured.");
  }
  if (policy.requireAccessPolicy && policy.allowedSchemas.length === 0 && policy.allowedTables.length === 0) {
    throw new Error(
      "Production read-only mode requires OB_ALLOWED_SCHEMAS or OB_ALLOWED_TABLES. Set OB_REQUIRE_ACCESS_POLICY=false only after a separate database-level read-only grant review."
    );
  }
  if (
    productionMode &&
    policy.allowedSchemas.length === 0 &&
    policy.allowedTables.some((entry) => !entry.includes("."))
  ) {
    throw new Error(
      "Production OB_ALLOWED_TABLES entries must be schema-qualified when OB_ALLOWED_SCHEMAS is unset."
    );
  }
  if (productionMode && !enforceReadOnlyTransaction) {
    throw new Error("OB_ENFORCE_READ_ONLY_TX=false is not allowed in production mode.");
  }
  if (!mcpReadOnly) {
    throw new Error("OB_MCP_READ_ONLY=false is not supported. This MCP server is read-only by design.");
  }

  return {
    profile,
    host: env.OB_HOST?.trim() || "127.0.0.1",
    port: parseInteger(env.OB_PORT, 2883, "OB_PORT"),
    user,
    password,
    database: emptyToUndefined(env.OB_DATABASE),
    compatibility,
    productionMode,
    mcpReadOnly,
    dbUserReadOnly,
    connectionLimit: parseInteger(env.OB_CONNECTION_LIMIT, 5, "OB_CONNECTION_LIMIT"),
    connectTimeoutMs: parseInteger(env.OB_CONNECT_TIMEOUT_MS, 10_000, "OB_CONNECT_TIMEOUT_MS"),
    queryTimeoutMs: parseInteger(env.OB_QUERY_TIMEOUT_MS, 30_000, "OB_QUERY_TIMEOUT_MS"),
    maxRows: parseInteger(env.OB_MAX_ROWS, 100, "OB_MAX_ROWS"),
    maxSqlLength: parseInteger(env.OB_MAX_SQL_LENGTH, 20_000, "OB_MAX_SQL_LENGTH"),
    maxParamCount: parseInteger(env.OB_MAX_PARAM_COUNT, 500, "OB_MAX_PARAM_COUNT"),
    enforceReadOnlyTransaction,
    requireTls,
    policy,
    ssl
  };
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const configuredProfiles = parseList(env.OB_PROFILES, []);
  const profileNames = configuredProfiles.length > 0 ? configuredProfiles : [env.OB_DEFAULT_PROFILE?.trim() || DEFAULT_PROFILE];
  const uniqueProfiles = [...new Set(profileNames.map(validateProfileName))];
  const defaultProfile = validateProfileName(env.OB_DEFAULT_PROFILE?.trim() || uniqueProfiles[0] || DEFAULT_PROFILE);
  if (!uniqueProfiles.includes(defaultProfile)) {
    throw new Error(`OB_DEFAULT_PROFILE "${defaultProfile}" must be included in OB_PROFILES.`);
  }

  const profiles: Record<string, ObConfig> = {};
  for (const profile of uniqueProfiles) {
    profiles[profile] = loadConfig(envWithProfileOverrides(env, profile), profile);
  }

  return {
    defaultProfile,
    profiles
  };
}

export function publicConfig(config: ObConfig): PublicObConfig {
  const { password, ssl, ...rest } = config;
  return {
    ...rest,
    passwordConfigured: password.length > 0,
    sslConfigured: ssl != null,
    sslRejectUnauthorized: ssl?.rejectUnauthorized
  };
}

export function loadHttpConfig(obConfig: ObConfig, env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.OB_MCP_HOST?.trim() || "127.0.0.1";
  const authToken = resolveSecret(env, "OB_MCP_AUTH_TOKEN");
  const allowedHosts = parseList(env.OB_MCP_ALLOWED_HOSTS, []);
  const allowedIps = parseList(env.OB_MCP_ALLOWED_IPS, []);
  validateAllowedIpRules(allowedIps);
  const trustProxy = parseBoolean(env.OB_MCP_TRUST_PROXY, false);
  const nonLocalBind = !isLocalHttpHost(host);
  if (obConfig.productionMode && !authToken) {
    throw new Error("OB_MCP_AUTH_TOKEN must be set when running the remote HTTP MCP server in production mode.");
  }
  if (nonLocalBind && !authToken) {
    throw new Error("OB_MCP_AUTH_TOKEN must be set when binding the HTTP MCP server to a non-local host.");
  }
  if (nonLocalBind && allowedHosts.length === 0) {
    throw new Error("OB_MCP_ALLOWED_HOSTS must be set when binding the HTTP MCP server to a non-local host.");
  }
  if (nonLocalBind && allowedIps.length === 0) {
    throw new Error("OB_MCP_ALLOWED_IPS must be set when binding the HTTP MCP server to a non-local host.");
  }

  return {
    host,
    port: parseInteger(env.OB_MCP_PORT, 3000, "OB_MCP_PORT"),
    path: env.OB_MCP_PATH?.trim() || "/mcp",
    authToken,
    allowedHosts,
    allowedIps,
    trustProxy,
    bodyLimit: env.OB_MCP_BODY_LIMIT?.trim() || "256kb",
    rateLimitWindowMs: parseInteger(env.OB_MCP_RATE_LIMIT_WINDOW_MS, 60_000, "OB_MCP_RATE_LIMIT_WINDOW_MS"),
    rateLimitMax: parseInteger(env.OB_MCP_RATE_LIMIT_MAX, 60, "OB_MCP_RATE_LIMIT_MAX")
  };
}

function isLocalHttpHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

function resolveUser(env: NodeJS.ProcessEnv, productionMode: boolean): string {
  const fullUser = env.OB_USER?.trim();
  if (fullUser) {
    return fullUser;
  }

  if (productionMode) {
    throw new Error("OB_USER must be set when OB_PRODUCTION=true or NODE_ENV=production.");
  }

  const username = env.OB_USERNAME?.trim() || DEFAULT_USERNAME;
  const tenant = env.OB_TENANT?.trim() || DEFAULT_TENANT;
  const cluster = env.OB_CLUSTER?.trim() || DEFAULT_CLUSTER;
  return `${username}@${tenant}${cluster ? `#${cluster}` : ""}`;
}

function resolvePassword(env: NodeJS.ProcessEnv, productionMode: boolean): string {
  const password = resolveSecret(env, "OB_PASSWORD");
  if (password != null) {
    return password;
  }

  if (productionMode) {
    throw new Error("OB_PASSWORD must be set when OB_PRODUCTION=true or NODE_ENV=production.");
  }

  return "ob_password";
}

function resolveSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct != null) {
    return direct;
  }

  const filePath = env[`${name}_FILE`]?.trim();
  if (!filePath) {
    return undefined;
  }

  try {
    return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    throw new Error(`Failed to read ${name}_FILE at ${filePath}: ${(error as Error).message}`);
  }
}

function parseCompatibility(value: string | undefined): CompatibilityMode {
  const normalized = value?.trim().toLowerCase() || "mysql";
  if (normalized === "mysql" || normalized === "oracle") {
    return normalized;
  }
  throw new Error(`Invalid OB_COMPATIBILITY "${value}". Expected "mysql" or "oracle".`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value "${value}". Expected true/false.`);
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function loadAccessPolicy(env: NodeJS.ProcessEnv, productionMode: boolean): AccessPolicy {
  const deniedSchemas = parseList(env.OB_DENIED_SCHEMAS, DEFAULT_DENIED_SCHEMAS);
  const deniedColumns = parseList(env.OB_DENIED_COLUMNS, DEFAULT_DENIED_COLUMNS);
  return {
    allowedSchemas: parseList(env.OB_ALLOWED_SCHEMAS, []),
    allowedTables: parseList(env.OB_ALLOWED_TABLES, []),
    deniedSchemas,
    deniedTables: parseList(env.OB_DENIED_TABLES, []),
    deniedColumns,
    allowSelectStar: parseBoolean(env.OB_ALLOW_SELECT_STAR, false),
    includeSystemSchemas: parseBoolean(env.OB_INCLUDE_SYSTEM_SCHEMAS, false),
    requireAccessPolicy: parseBoolean(env.OB_REQUIRE_ACCESS_POLICY, productionMode)
  };
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value == null || value.trim() === "") {
    return [...fallback];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateProfileName(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
    throw new Error(`Invalid profile name "${value}". Use letters, numbers, underscores, or dashes.`);
  }
  return profile;
}

function envWithProfileOverrides(env: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv {
  const prefix = `OB_PROFILE_${profile.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
  const output: NodeJS.ProcessEnv = { ...env };
  const overrideKeys = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix)) {
      const targetKey = `OB_${key.slice(prefix.length)}`;
      output[targetKey] = value;
      overrideKeys.add(targetKey);
    }
  }
  applyProfileSecretFileOverride(output, overrideKeys, "OB_PASSWORD");
  return output;
}

function applyProfileSecretFileOverride(output: NodeJS.ProcessEnv, overrideKeys: Set<string>, name: string): void {
  if (overrideKeys.has(`${name}_FILE`) && !overrideKeys.has(name)) {
    delete output[name];
  }
}

function loadSslConfig(env: NodeJS.ProcessEnv): ObSslConfig | undefined {
  const ca = readOptionalFile(env.OB_SSL_CA, "OB_SSL_CA");
  const cert = readOptionalFile(env.OB_SSL_CERT, "OB_SSL_CERT");
  const key = readOptionalFile(env.OB_SSL_KEY, "OB_SSL_KEY");
  const rejectUnauthorized = parseBoolean(env.OB_SSL_REJECT_UNAUTHORIZED, true);

  if (!ca && !cert && !key && env.OB_SSL !== "true") {
    return undefined;
  }

  return {
    ca,
    cert,
    key,
    rejectUnauthorized
  };
}

function readOptionalFile(path: string | undefined, name: string): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return readFileSync(trimmed, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${name} file at ${trimmed}: ${(error as Error).message}`);
  }
}
