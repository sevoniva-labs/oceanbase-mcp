import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConfig, loadGatewayConfig, loadHttpConfig, publicConfig } from "../dist/config.js";
import { diagnoseGateway } from "../dist/diagnostics.js";

test("loadConfig uses local OceanBase defaults outside production", () => {
  const config = loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 2883);
  assert.equal(config.user, "ob_user@ob_mysql#obcluster");
  assert.equal(config.password, "ob_password");
  assert.equal(config.productionMode, false);
  assert.equal(config.mcpReadOnly, true);
});

test("loadConfig builds user from OceanBase username tenant and cluster", () => {
  const config = loadConfig({
    OB_USERNAME: "alice",
    OB_TENANT: "tenant1",
    OB_CLUSTER: "cluster1",
    OB_PASSWORD: "secret"
  });
  assert.equal(config.user, "alice@tenant1#cluster1");
});

test("loadConfig reads password from file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-test-"));
  try {
    const file = join(dir, "password");
    writeFileSync(file, "from-file\n");
    const config = loadConfig({ OB_USER: "u@t#c", OB_PASSWORD_FILE: file });
    assert.equal(config.password, "from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadGatewayConfig supports multiple profiles and prefixed overrides", () => {
  const gateway = loadGatewayConfig({
    OB_PROFILES: "dev,prod",
    OB_DEFAULT_PROFILE: "dev",
    OB_USER: "dev@tenant#cluster",
    OB_PASSWORD: "dev-secret",
    OB_PROFILE_PROD_USER: "prod@tenant#cluster",
    OB_PROFILE_PROD_PASSWORD: "prod-secret",
    OB_PROFILE_PROD_PRODUCTION: "true",
    OB_PROFILE_PROD_ALLOWED_SCHEMAS: "app"
  });

  assert.equal(gateway.defaultProfile, "dev");
  assert.equal(gateway.profiles.dev.user, "dev@tenant#cluster");
  assert.equal(gateway.profiles.prod.user, "prod@tenant#cluster");
  assert.equal(gateway.profiles.prod.productionMode, true);
  assert.deepEqual(gateway.profiles.prod.policy.allowedSchemas, ["app"]);
});

test("profile-specific password file overrides inherited base password", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-test-"));
  try {
    const file = join(dir, "prod-password");
    writeFileSync(file, "prod-from-file\n");
    const gateway = loadGatewayConfig({
      OB_PROFILES: "dev,prod",
      OB_DEFAULT_PROFILE: "dev",
      OB_USER: "dev@tenant#cluster",
      OB_PASSWORD: "dev-secret",
      OB_PROFILE_PROD_USER: "prod@tenant#cluster",
      OB_PROFILE_PROD_PASSWORD_FILE: file,
      OB_PROFILE_PROD_PRODUCTION: "true",
      OB_PROFILE_PROD_ALLOWED_SCHEMAS: "app"
    });

    assert.equal(gateway.profiles.dev.password, "dev-secret");
    assert.equal(gateway.profiles.prod.password, "prod-from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig requires explicit credentials in production", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /OB_USER must be set/);
  assert.throws(() => loadConfig({ NODE_ENV: "production", OB_USER: "u@t#c" }), /OB_PASSWORD must be set/);
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", OB_USER: "u@t#c", OB_PASSWORD: "secret" }),
    /requires OB_ALLOWED_SCHEMAS or OB_ALLOWED_TABLES/
  );
  assert.doesNotThrow(() =>
    loadConfig({
      NODE_ENV: "production",
      OB_USER: "u@t#c",
      OB_PASSWORD: "secret",
      OB_ALLOWED_SCHEMAS: "app"
    })
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OB_USER: "u@t#c",
        OB_PASSWORD: "secret",
        OB_ALLOWED_TABLES: "orders"
      }),
    /schema-qualified/
  );
  assert.doesNotThrow(() =>
    loadConfig({
      NODE_ENV: "production",
      OB_USER: "u@t#c",
      OB_PASSWORD: "secret",
      OB_ALLOWED_TABLES: "app.orders"
    })
  );
});

test("loadConfig keeps read-only transactions mandatory in production", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OB_USER: "u@t#c",
        OB_PASSWORD: "secret",
        OB_ALLOWED_SCHEMAS: "app",
        OB_ENFORCE_READ_ONLY_TX: "false"
      }),
    /OB_ENFORCE_READ_ONLY_TX=false/
  );
});

test("loadConfig does not support disabling MCP read-only mode", () => {
  assert.throws(() => loadConfig({ OB_MCP_READ_ONLY: "false" }), /OB_MCP_READ_ONLY=false is not supported/);
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        OB_USER: "u@t#c",
        OB_PASSWORD: "secret",
        OB_ALLOWED_SCHEMAS: "app",
        OB_MCP_READ_ONLY: "false"
      }),
    /OB_MCP_READ_ONLY=false is not supported/
  );
});

test("publicConfig redacts sensitive connection material", () => {
  const config = loadConfig({
    OB_USER: "u@t#c",
    OB_PASSWORD: "secret",
    OB_SSL: "true",
    OB_SSL_REJECT_UNAUTHORIZED: "false"
  });
  const safe = publicConfig(config);
  assert.equal("password" in safe, false);
  assert.equal("ssl" in safe, false);
  assert.equal(safe.passwordConfigured, true);
  assert.equal(safe.sslConfigured, true);
  assert.equal(safe.sslRejectUnauthorized, false);
});

test("loadHttpConfig requires a bearer token in production", () => {
  const productionConfig = loadConfig({
    NODE_ENV: "production",
    OB_USER: "u@t#c",
    OB_PASSWORD: "secret",
    OB_ALLOWED_SCHEMAS: "app"
  });
  assert.throws(() => loadHttpConfig(productionConfig, {}), /OB_MCP_AUTH_TOKEN/);
  assert.equal(loadHttpConfig(productionConfig, { OB_MCP_AUTH_TOKEN: "token" }).authToken, "token");
});

test("loadHttpConfig applies HTTP hardening defaults", () => {
  const httpConfig = loadHttpConfig(loadConfig({}), {});
  assert.equal(httpConfig.bodyLimit, "256kb");
  assert.equal(httpConfig.rateLimitWindowMs, 60_000);
  assert.equal(httpConfig.rateLimitMax, 60);
  assert.deepEqual(httpConfig.allowedIps, []);
  assert.equal(httpConfig.trustProxy, false);
});

test("loadHttpConfig requires auth and allowed hosts for non-local binds", () => {
  const localConfig = loadConfig({});
  assert.throws(() => loadHttpConfig(localConfig, { OB_MCP_HOST: "0.0.0.0" }), /OB_MCP_AUTH_TOKEN/);
  assert.throws(
    () => loadHttpConfig(localConfig, { OB_MCP_HOST: "0.0.0.0", OB_MCP_AUTH_TOKEN: "token" }),
    /OB_MCP_ALLOWED_HOSTS/
  );
  const httpConfig = loadHttpConfig(localConfig, {
    OB_MCP_HOST: "0.0.0.0",
    OB_MCP_AUTH_TOKEN: "token",
    OB_MCP_ALLOWED_HOSTS: "mcp.local",
    OB_MCP_ALLOWED_IPS: "203.0.113.10,10.0.0.0/8",
    OB_MCP_TRUST_PROXY: "true"
  });
  assert.equal(httpConfig.authToken, "token");
  assert.deepEqual(httpConfig.allowedHosts, ["mcp.local"]);
  assert.deepEqual(httpConfig.allowedIps, ["203.0.113.10", "10.0.0.0/8"]);
  assert.equal(httpConfig.trustProxy, true);
});

test("loadHttpConfig validates source IP allowlist for remote binds", () => {
  const localConfig = loadConfig({});
  assert.throws(
    () =>
      loadHttpConfig(localConfig, {
        OB_MCP_HOST: "0.0.0.0",
        OB_MCP_AUTH_TOKEN: "token",
        OB_MCP_ALLOWED_HOSTS: "mcp.local"
      }),
    /OB_MCP_ALLOWED_IPS/
  );
  assert.throws(
    () => loadHttpConfig(localConfig, { OB_MCP_ALLOWED_IPS: "not-an-ip" }),
    /Invalid OB_MCP_ALLOWED_IPS/
  );
});

test("loadHttpConfig requires allowed hosts for non-local production binds", () => {
  const productionConfig = loadConfig({
    NODE_ENV: "production",
    OB_USER: "u@t#c",
    OB_PASSWORD: "secret",
    OB_ALLOWED_SCHEMAS: "app"
  });
  assert.throws(
    () => loadHttpConfig(productionConfig, { OB_MCP_AUTH_TOKEN: "token", OB_MCP_HOST: "0.0.0.0" }),
    /OB_MCP_ALLOWED_HOSTS/
  );
  assert.deepEqual(
    loadHttpConfig(productionConfig, {
      OB_MCP_AUTH_TOKEN: "token",
      OB_MCP_HOST: "0.0.0.0",
      OB_MCP_ALLOWED_HOSTS: "mcp.example.com",
      OB_MCP_ALLOWED_IPS: "203.0.113.0/24"
    }).allowedHosts,
    ["mcp.example.com"]
  );
});

test("diagnoseGateway reports production profile hardening", () => {
  const gateway = loadGatewayConfig({
    OB_PROFILES: "prod",
    OB_DEFAULT_PROFILE: "prod",
    OB_PROFILE_PROD_USER: "prod@tenant#cluster",
    OB_PROFILE_PROD_PASSWORD: "secret",
    OB_PROFILE_PROD_PRODUCTION: "true",
    OB_PROFILE_PROD_ALLOWED_SCHEMAS: "app",
    OB_PROFILE_PROD_REQUIRE_TLS: "true",
    OB_PROFILE_PROD_SSL: "true"
  });
  const httpConfig = loadHttpConfig(gateway.profiles.prod, { OB_MCP_AUTH_TOKEN: "token" });
  const report = diagnoseGateway(gateway, httpConfig);
  assert.equal(report.ok, true);
  assert(report.checks.some((check) => check.id === "profile.access_policy" && check.severity === "pass"));
  assert(report.checks.some((check) => check.id === "profile.mcp_read_only" && check.severity === "pass"));
  assert(report.checks.some((check) => check.id === "profile.db_user_read_only" && check.severity === "warn"));
  assert(report.checks.some((check) => check.id === "http.auth_token" && check.severity === "pass"));
  assert(report.checks.some((check) => check.id === "http.allowed_ips" && check.severity === "pass"));
});
