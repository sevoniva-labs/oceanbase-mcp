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
  maskedColumns: string[];
  allowSelectStar: boolean;
  includeSystemSchemas: boolean;
  requireAccessPolicy: boolean;
}

export interface BusinessGlossaryTarget {
  schema?: string;
  table?: string;
  column?: string;
  description?: string;
}

export interface BusinessGlossaryEntry {
  term: string;
  aliases: string[];
  description?: string;
  targets: BusinessGlossaryTarget[];
}

export interface BusinessGlossary {
  entries: BusinessGlossaryEntry[];
  file: string;
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
  maxResultBytes: number;
  maxSqlLength: number;
  maxParamCount: number;
  maxConcurrentQueries: number;
  erTotalTimeoutMs: number;
  erQueryTimeoutMs: number;
  erMaxTables: number;
  erMaxColumnsPerTable: number;
  erMaxRelationships: number;
  erInlineHtmlMaxBytes: number;
  metadataCacheEnabled: boolean;
  metadataCacheTtlMs: number;
  metadataCacheMaxEntries: number;
  enforceReadOnlyTransaction: boolean;
  requireTls: boolean;
  policy: AccessPolicy;
  businessGlossary?: BusinessGlossary;
  ssl?: ObSslConfig;
}

export interface AuthTokenPolicy {
  name: string;
  token: string;
  profiles?: string[];
  tools?: string[];
}

export interface AuthPrincipal {
  name: string;
  profiles?: string[];
  tools?: string[];
}

export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  authTokens: AuthTokenPolicy[];
  allowedHosts?: string[];
  allowedIps: string[];
  trustProxy: boolean | number | string;
  trustProxyDescription: string;
  bodyLimit: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  metricsAuthRequired: boolean;
  healthAuthRequired: boolean;
  clientIdHeader: string;
}

export interface GatewayConfig {
  defaultProfile: string;
  profiles: Record<string, ObConfig>;
}

export interface PublicObConfig
  extends Omit<ObConfig, "password" | "ssl" | "businessGlossary"> {
  passwordConfigured: boolean;
  sslConfigured: boolean;
  sslRejectUnauthorized?: boolean;
  businessGlossaryConfigured: boolean;
  businessGlossaryEntries: number;
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
const TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
  const businessGlossary = loadBusinessGlossary(env);
  const enforceReadOnlyTransaction = parseBoolean(env.OB_ENFORCE_READ_ONLY_TX, true);
  const connectionLimit = parseInteger(env.OB_CONNECTION_LIMIT, 5, "OB_CONNECTION_LIMIT");
  const queryTimeoutMs = parseInteger(env.OB_QUERY_TIMEOUT_MS, 30_000, "OB_QUERY_TIMEOUT_MS");
  const maxResultBytes = parseInteger(env.OB_MAX_RESULT_BYTES, 1_048_576, "OB_MAX_RESULT_BYTES");
  const metadataCacheEnabled = parseBoolean(env.OB_METADATA_CACHE_ENABLED ?? env.OB_METADATA_CACHE, true);
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
    connectionLimit,
    connectTimeoutMs: parseInteger(env.OB_CONNECT_TIMEOUT_MS, 10_000, "OB_CONNECT_TIMEOUT_MS"),
    queryTimeoutMs,
    maxRows: parseInteger(env.OB_MAX_ROWS, 100, "OB_MAX_ROWS"),
    maxResultBytes,
    maxSqlLength: parseInteger(env.OB_MAX_SQL_LENGTH, 20_000, "OB_MAX_SQL_LENGTH"),
    maxParamCount: parseInteger(env.OB_MAX_PARAM_COUNT, 500, "OB_MAX_PARAM_COUNT"),
    maxConcurrentQueries: parseInteger(env.OB_MAX_CONCURRENT_QUERIES, Math.max(1, Math.min(connectionLimit, 5)), "OB_MAX_CONCURRENT_QUERIES"),
    erTotalTimeoutMs: parseInteger(env.OB_ER_TOTAL_TIMEOUT_MS, 15_000, "OB_ER_TOTAL_TIMEOUT_MS"),
    erQueryTimeoutMs: parseInteger(env.OB_ER_QUERY_TIMEOUT_MS, Math.min(queryTimeoutMs, 5_000), "OB_ER_QUERY_TIMEOUT_MS"),
    erMaxTables: parseInteger(env.OB_ER_MAX_TABLES, 50, "OB_ER_MAX_TABLES"),
    erMaxColumnsPerTable: parseInteger(env.OB_ER_MAX_COLUMNS_PER_TABLE, 12, "OB_ER_MAX_COLUMNS_PER_TABLE"),
    erMaxRelationships: parseInteger(env.OB_ER_MAX_RELATIONSHIPS, 100, "OB_ER_MAX_RELATIONSHIPS"),
    erInlineHtmlMaxBytes: parseInteger(env.OB_ER_INLINE_HTML_MAX_BYTES, Math.min(maxResultBytes, 262_144), "OB_ER_INLINE_HTML_MAX_BYTES"),
    metadataCacheEnabled,
    metadataCacheTtlMs: parseInteger(env.OB_METADATA_CACHE_TTL_MS, 60_000, "OB_METADATA_CACHE_TTL_MS"),
    metadataCacheMaxEntries: parseInteger(env.OB_METADATA_CACHE_MAX_ENTRIES, 500, "OB_METADATA_CACHE_MAX_ENTRIES"),
    enforceReadOnlyTransaction,
    requireTls,
    policy,
    businessGlossary,
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
  const { password, ssl, businessGlossary, ...rest } = config;
  return {
    ...rest,
    passwordConfigured: password.length > 0,
    sslConfigured: ssl != null,
    sslRejectUnauthorized: ssl?.rejectUnauthorized,
    businessGlossaryConfigured: businessGlossary != null,
    businessGlossaryEntries: businessGlossary?.entries.length ?? 0
  };
}

export function loadHttpConfig(obConfig: ObConfig, env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.OB_MCP_HOST?.trim() || "127.0.0.1";
  const authToken = resolveSecret(env, "OB_MCP_AUTH_TOKEN");
  const authTokens = loadAuthTokenPolicies(env, authToken);
  const allowedHosts = parseList(env.OB_MCP_ALLOWED_HOSTS, []);
  const allowedIps = parseList(env.OB_MCP_ALLOWED_IPS, []);
  validateAllowedIpRules(allowedIps);
  const trustProxy = parseTrustProxy(env.OB_MCP_TRUST_PROXY);
  const nonLocalBind = !isLocalHttpHost(host);
  const hasAuthToken = authTokens.length > 0;
  if (obConfig.productionMode && !hasAuthToken) {
    throw new Error("OB_MCP_AUTH_TOKEN must be set when running the remote HTTP MCP server in production mode.");
  }
  if (nonLocalBind && !hasAuthToken) {
    throw new Error("OB_MCP_AUTH_TOKEN must be set when binding the HTTP MCP server to a non-local host.");
  }
  validateAuthTokenStrength(authTokens, obConfig.productionMode || nonLocalBind);
  if (nonLocalBind && allowedHosts.length === 0) {
    throw new Error("OB_MCP_ALLOWED_HOSTS must be set when binding the HTTP MCP server to a non-local host.");
  }
  if (nonLocalBind && allowedIps.length === 0) {
    throw new Error("OB_MCP_ALLOWED_IPS must be set when binding the HTTP MCP server to a non-local host.");
  }
  const clientIdHeader = validateHeaderName(env.OB_MCP_CLIENT_ID_HEADER?.trim() || "x-ob-mcp-client-id", "OB_MCP_CLIENT_ID_HEADER");
  const metricsAuthRequired = parseBoolean(env.OB_MCP_METRICS_AUTH_REQUIRED, obConfig.productionMode || nonLocalBind);
  const healthAuthRequired = parseBoolean(env.OB_MCP_HEALTH_AUTH_REQUIRED, false);
  if ((metricsAuthRequired || healthAuthRequired) && !hasAuthToken) {
    throw new Error("Endpoint auth was requested, but no HTTP bearer token policy is configured.");
  }

  return {
    host,
    port: parseInteger(env.OB_MCP_PORT, 3000, "OB_MCP_PORT"),
    path: env.OB_MCP_PATH?.trim() || "/mcp",
    authToken,
    authTokens,
    allowedHosts,
    allowedIps,
    trustProxy,
    trustProxyDescription: describeTrustProxy(trustProxy),
    bodyLimit: env.OB_MCP_BODY_LIMIT?.trim() || "256kb",
    rateLimitWindowMs: parseInteger(env.OB_MCP_RATE_LIMIT_WINDOW_MS, 60_000, "OB_MCP_RATE_LIMIT_WINDOW_MS"),
    rateLimitMax: parseInteger(env.OB_MCP_RATE_LIMIT_MAX, 60, "OB_MCP_RATE_LIMIT_MAX"),
    metricsAuthRequired,
    healthAuthRequired,
    clientIdHeader
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

function loadBusinessGlossary(env: NodeJS.ProcessEnv): BusinessGlossary | undefined {
  const filePath = env.OB_BUSINESS_GLOSSARY_FILE?.trim();
  if (!filePath) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read OB_BUSINESS_GLOSSARY_FILE at ${filePath}: ${(error as Error).message}`);
  }

  const terms: unknown[] | undefined = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).terms)
      ? (parsed as Record<string, unknown>).terms as unknown[]
      : undefined;
  if (!terms) {
    throw new Error("OB_BUSINESS_GLOSSARY_FILE must contain a JSON array or an object with a terms array.");
  }
  if (terms.length > 1000) {
    throw new Error("OB_BUSINESS_GLOSSARY_FILE supports at most 1000 terms.");
  }

  return {
    file: filePath,
    entries: terms.map((entry, index) => parseBusinessGlossaryEntry(entry, index))
  };
}

function parseBusinessGlossaryEntry(value: unknown, index: number): BusinessGlossaryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Business glossary term ${index + 1} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const term = glossaryText(record.term, `terms[${index}].term`, true)!;
  const aliases = parseOptionalStringArray(record.aliases, `terms[${index}].aliases`, (item) =>
    validateGlossaryText(item, `terms[${index}].aliases`)
  ) ?? [];
  const targets = record.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`terms[${index}].targets must be a non-empty array.`);
  }
  if (targets.length > 100) {
    throw new Error(`terms[${index}].targets supports at most 100 targets.`);
  }

  return {
    term,
    aliases,
    description: glossaryText(record.description, `terms[${index}].description`, false),
    targets: targets.map((target, targetIndex) => parseBusinessGlossaryTarget(target, index, targetIndex))
  };
}

function parseBusinessGlossaryTarget(value: unknown, termIndex: number, targetIndex: number): BusinessGlossaryTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`terms[${termIndex}].targets[${targetIndex}] must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const target = {
    schema: glossaryText(record.schema, `terms[${termIndex}].targets[${targetIndex}].schema`, false),
    table: glossaryText(record.table, `terms[${termIndex}].targets[${targetIndex}].table`, false),
    column: glossaryText(record.column, `terms[${termIndex}].targets[${targetIndex}].column`, false),
    description: glossaryText(record.description, `terms[${termIndex}].targets[${targetIndex}].description`, false)
  };
  if (!target.schema && !target.table) {
    throw new Error(`terms[${termIndex}].targets[${targetIndex}] requires schema or table.`);
  }
  if (target.column && !target.table) {
    throw new Error(`terms[${termIndex}].targets[${targetIndex}].column requires table.`);
  }
  return target;
}

function glossaryText(value: unknown, name: string, required: boolean): string | undefined {
  if (value == null) {
    if (required) {
      throw new Error(`${name} is required.`);
    }
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return validateGlossaryText(value, name);
}

function validateGlossaryText(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 256) {
    throw new Error(`${name} must be 256 characters or fewer.`);
  }
  return trimmed;
}

function loadAuthTokenPolicies(env: NodeJS.ProcessEnv, directToken: string | undefined): AuthTokenPolicy[] {
  const policies: AuthTokenPolicy[] = [];
  if (directToken) {
    policies.push({ name: "default", token: directToken });
  }

  const policiesJson = resolveSecret(env, "OB_MCP_AUTH_TOKENS");
  if (!policiesJson) {
    return policies;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(policiesJson);
  } catch (error) {
    throw new Error(`OB_MCP_AUTH_TOKENS must be valid JSON: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("OB_MCP_AUTH_TOKENS must be a JSON array.");
  }

  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`OB_MCP_AUTH_TOKENS[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const token = typeof record.token === "string" ? record.token : undefined;
    const tokenFile = typeof record.tokenFile === "string" ? record.tokenFile.trim() : undefined;
    const resolvedToken = token ?? (tokenFile ? readFileSync(tokenFile, "utf8").replace(/\r?\n$/, "") : undefined);
    if (!resolvedToken) {
      throw new Error(`OB_MCP_AUTH_TOKENS[${index}] requires token or tokenFile.`);
    }
    const name =
      typeof record.name === "string" && record.name.trim()
        ? validateTokenPolicyName(record.name)
        : `token-${index + 1}`;
    policies.push({
      name,
      token: resolvedToken,
      profiles: parseOptionalStringArray(record.profiles, `OB_MCP_AUTH_TOKENS[${index}].profiles`, validateProfileName),
      tools: parseOptionalStringArray(record.tools, `OB_MCP_AUTH_TOKENS[${index}].tools`, validateToolName)
    });
  });

  const seen = new Set<string>();
  for (const policy of policies) {
    if (seen.has(policy.token)) {
      throw new Error(`Duplicate bearer token configured for "${policy.name}".`);
    }
    seen.add(policy.token);
  }
  return policies;
}

function validateAuthTokenStrength(policies: AuthTokenPolicy[], strict: boolean): void {
  if (!strict) {
    return;
  }

  const weak = policies.find((policy) => Buffer.byteLength(policy.token, "utf8") < 32);
  if (weak) {
    throw new Error(`HTTP bearer token "${weak.name}" must be at least 32 bytes in production or non-local HTTP mode.`);
  }
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  if (/^\d+$/.test(normalized)) {
    const hops = Number.parseInt(normalized, 10);
    if (hops <= 0) {
      throw new Error("OB_MCP_TRUST_PROXY hop count must be a positive integer.");
    }
    return hops;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  const entries = parseList(trimmed, []);
  for (const entry of entries) {
    const preset = entry.toLowerCase();
    if (TRUST_PROXY_PRESETS.has(preset)) {
      continue;
    }
    try {
      validateAllowedIpRules([entry]);
    } catch {
      throw new Error(`Invalid OB_MCP_TRUST_PROXY entry "${entry}". Use false, true, hop count, loopback, or IP/CIDR entries.`);
    }
  }
  return entries.join(",");
}

function describeTrustProxy(value: boolean | number | string): string {
  if (value === false) {
    return "disabled";
  }
  if (value === true) {
    return "all proxies";
  }
  if (typeof value === "number") {
    return `${value} trusted hop${value === 1 ? "" : "s"}`;
  }
  return value;
}

function parseOptionalStringArray(
  value: unknown,
  name: string,
  validate: (value: string) => string
): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${name}[${index}] must be a string.`);
    }
    return validate(entry);
  });
}

function validateTokenPolicyName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    throw new Error(`Invalid auth token policy name "${value}". Use letters, numbers, underscores, dashes, or dots.`);
  }
  return name;
}

function validateToolName(value: string): string {
  const tool = value.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool)) {
    throw new Error(`Invalid tool name "${value}".`);
  }
  return tool;
}

function validateHeaderName(value: string, name: string): string {
  if (!HEADER_NAME_PATTERN.test(value)) {
    throw new Error(`${name} must be a valid HTTP header name.`);
  }
  return value.toLowerCase();
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
    maskedColumns: parseList(env.OB_MASKED_COLUMNS, []),
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
