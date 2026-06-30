import type { GatewayConfig, HttpConfig, ObConfig } from "./config.js";

export type DiagnosticSeverity = "pass" | "warn" | "fail";

export interface DiagnosticCheck {
  id: string;
  severity: DiagnosticSeverity;
  profile?: string;
  message: string;
  remediation?: string;
}

export interface DiagnosticReport {
  ok: boolean;
  defaultProfile: string;
  profiles: string[];
  checks: DiagnosticCheck[];
}

export function diagnoseGateway(config: GatewayConfig, httpConfig?: HttpConfig): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];
  for (const profile of Object.values(config.profiles)) {
    checks.push(...diagnoseProfile(profile));
  }

  if (httpConfig) {
    const nonLocal = !["127.0.0.1", "localhost", "::1", "[::1]"].includes(httpConfig.host.toLowerCase());
    checks.push({
      id: "http.auth_token",
      severity: httpConfig.authTokens.length > 0 ? "pass" : "warn",
      message:
        httpConfig.authTokens.length > 0
          ? `HTTP MCP bearer token policy is configured (${httpConfig.authTokens.length} token${httpConfig.authTokens.length === 1 ? "" : "s"}).`
          : "HTTP MCP bearer token is not configured.",
      remediation: "Set OB_MCP_AUTH_TOKEN, OB_MCP_AUTH_TOKEN_FILE, or scoped OB_MCP_AUTH_TOKENS for remote HTTP deployments."
    });
    checks.push({
      id: "http.allowed_hosts",
      severity: !nonLocal || (httpConfig.allowedHosts?.length ?? 0) > 0 ? "pass" : "fail",
      message:
        !nonLocal || (httpConfig.allowedHosts?.length ?? 0) > 0
          ? "HTTP Host allowlist is acceptable for the bind host."
          : "Non-local HTTP bind requires OB_MCP_ALLOWED_HOSTS.",
      remediation: "Set OB_MCP_ALLOWED_HOSTS to the public MCP host names."
    });
    checks.push({
      id: "http.allowed_ips",
      severity: !nonLocal || httpConfig.allowedIps.length > 0 ? "pass" : "warn",
      message:
        httpConfig.allowedIps.length > 0
          ? "HTTP source IP allowlist is configured."
          : nonLocal
            ? "HTTP source IP allowlist is not configured."
            : "HTTP source IP allowlist is not required for a local-only bind.",
      remediation: "Set OB_MCP_ALLOWED_IPS to approved client or reverse-proxy IP addresses/CIDR ranges."
    });
    checks.push({
      id: "http.trust_proxy",
      severity: httpConfig.trustProxy === true && nonLocal ? "warn" : "pass",
      message:
        httpConfig.trustProxy === false
          ? "HTTP proxy trust is disabled; source IP checks use the direct peer address."
          : `HTTP proxy trust is set to ${httpConfig.trustProxyDescription}.`,
      remediation: "Prefer OB_MCP_TRUST_PROXY=loopback, a hop count, or explicit trusted proxy CIDR instead of trusting all proxies."
    });
    checks.push({
      id: "http.metrics_auth",
      severity: httpConfig.metricsAuthRequired || !nonLocal ? "pass" : "warn",
      message: httpConfig.metricsAuthRequired ? "/metrics requires bearer auth." : "/metrics does not require bearer auth.",
      remediation: "Set OB_MCP_METRICS_AUTH_REQUIRED=true unless metrics are available only inside a trusted monitoring network."
    });
    checks.push({
      id: "http.health_auth",
      severity: httpConfig.healthAuthRequired || !nonLocal ? "pass" : "warn",
      message: httpConfig.healthAuthRequired ? "/healthz requires bearer auth." : "/healthz does not require bearer auth.",
      remediation: "Set OB_MCP_HEALTH_AUTH_REQUIRED=true if external users can reach /healthz."
    });
    checks.push({
      id: "http.rate_limit",
      severity: httpConfig.rateLimitWindowMs > 0 && httpConfig.rateLimitMax > 0 ? "pass" : "fail",
      message: "HTTP MCP rate limit settings are present."
    });
    checks.push({
      id: "http.body_limit",
      severity: httpConfig.bodyLimit ? "pass" : "fail",
      message: `HTTP MCP body limit is ${httpConfig.bodyLimit || "unset"}.`
    });
  }

  return {
    ok: checks.every((check) => check.severity !== "fail"),
    defaultProfile: config.defaultProfile,
    profiles: Object.keys(config.profiles),
    checks
  };
}

function diagnoseProfile(config: ObConfig): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const profile = config.profile;
  checks.push({
    id: "profile.credentials",
    profile,
    severity: config.user && config.password ? "pass" : "fail",
    message: config.user && config.password ? "OceanBase credentials are configured." : "OceanBase credentials are incomplete.",
    remediation: "Set OB_USER and OB_PASSWORD or OB_PASSWORD_FILE."
  });
  checks.push({
    id: "profile.db_user_read_only",
    profile,
    severity: config.dbUserReadOnly ? "pass" : "warn",
    message: config.dbUserReadOnly
      ? "Database account is declared as read-only as defense in depth."
      : "Database account is not declared as read-only; MCP still enforces read-only access.",
    remediation: "Prefer an OceanBase account with SELECT/metadata read privileges only, then set OB_DB_USER_READ_ONLY=true."
  });
  checks.push({
    id: "profile.mcp_read_only",
    profile,
    severity: config.mcpReadOnly ? "pass" : "fail",
    message: config.mcpReadOnly ? "MCP gateway read-only mode is enforced." : "MCP gateway read-only mode is disabled.",
    remediation: "Keep OB_MCP_READ_ONLY=true. Write mode is not supported by this server."
  });
  checks.push({
    id: "profile.access_policy",
    profile,
    severity: config.policy.allowedSchemas.length > 0 || config.policy.allowedTables.length > 0 ? "pass" : config.productionMode ? "fail" : "warn",
    message:
      config.policy.allowedSchemas.length > 0 || config.policy.allowedTables.length > 0
        ? "Schema/table access policy is configured."
        : "No schema/table allowlist is configured.",
    remediation: "Set OB_ALLOWED_SCHEMAS or OB_ALLOWED_TABLES, especially in production."
  });
  checks.push({
    id: "profile.read_only_tx",
    profile,
    severity: config.enforceReadOnlyTransaction ? "pass" : config.productionMode ? "fail" : "warn",
    message: config.enforceReadOnlyTransaction
      ? "Read-only transaction enforcement is enabled."
      : "Read-only transaction enforcement is disabled.",
    remediation: "Keep OB_ENFORCE_READ_ONLY_TX=true."
  });
  checks.push({
    id: "profile.max_rows",
    profile,
    severity: config.maxRows > 0 ? "pass" : "fail",
    message: `OB_MAX_ROWS hard cap is ${config.maxRows}.`
  });
  checks.push({
    id: "profile.max_result_bytes",
    profile,
    severity: config.maxResultBytes > 0 ? "pass" : "fail",
    message: `OB_MAX_RESULT_BYTES hard cap is ${config.maxResultBytes}.`
  });
  checks.push({
    id: "profile.max_concurrent_queries",
    profile,
    severity: config.maxConcurrentQueries > 0 ? "pass" : "fail",
    message: `OB_MAX_CONCURRENT_QUERIES is ${config.maxConcurrentQueries}.`
  });
  checks.push({
    id: "profile.select_star",
    profile,
    severity: config.policy.allowSelectStar ? "warn" : "pass",
    message: config.policy.allowSelectStar ? "SELECT * is allowed." : "SELECT * is blocked by default.",
    remediation: "Keep OB_ALLOW_SELECT_STAR=false unless reviewed."
  });
  checks.push({
    id: "profile.system_schemas",
    profile,
    severity: config.policy.includeSystemSchemas ? "warn" : "pass",
    message: config.policy.includeSystemSchemas ? "System schemas are included." : "System schemas are hidden by default.",
    remediation: "Keep OB_INCLUDE_SYSTEM_SCHEMAS=false for ordinary production use."
  });
  checks.push({
    id: "profile.tls",
    profile,
    severity: config.requireTls && config.ssl ? "pass" : config.productionMode ? "warn" : "pass",
    message:
      config.requireTls && config.ssl
        ? "TLS is required and SSL material is configured."
        : config.productionMode
          ? "TLS is not required by this profile."
          : "TLS requirement is not enabled for this non-production profile.",
    remediation: "Set OB_REQUIRE_TLS=true and OB_SSL_CA/OB_SSL_CERT/OB_SSL_KEY for production endpoints that support TLS."
  });
  return checks;
}
