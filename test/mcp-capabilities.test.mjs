import assert from "node:assert/strict";
import test from "node:test";

import { assertToolManifest, resolveToolBudget, TOOL_CAPABILITIES } from "../dist/capabilities.js";
import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_list_capabilities returns visible tools and read-only limits", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config));
  const result = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_list_capabilities, {}, {})).content[0].text);

  assert.equal(result.name, "ob-mcp");
  assert.equal(result.readOnly.enforced, true);
  assert.equal(result.readOnly.writeTools, false);
  assert(result.groups.includes("query"));
  assert(result.tools.some((tool) => tool.name === "ob_query" && tool.since === "v0.3.0"));
  assert(result.tools.some((tool) => tool.name === "ob_check_opencode_setup" && tool.since === "v1.0.0"));
  assert(result.tools.some((tool) => tool.name === "ob_get_usage_guide" && tool.since === "v1.0.0"));
  assert(result.tools.every((tool) => tool.readOnly === true));
  assert(result.tools.every((tool) => typeof tool.operationType === "string"));
  assert(result.tools.every((tool) => typeof tool.budget?.maxBytes === "string"));
  assert(result.tools.every((tool) => typeof tool.budget?.timeoutMs === "string"));
  assert(result.tools.every((tool) => typeof tool.mysqlSmoke === "boolean"));
  assert(result.tools.every((tool) => typeof tool.oracleSmoke === "boolean"));
  assert.deepEqual(result.tools.map(toolSortKey), [...result.tools].sort(compareTools).map(toolSortKey));
});

test("ob_list_capabilities honors token tool scope", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config), undefined, {
    principal: {
      name: "limited",
      tools: ["ob_list_capabilities"]
    }
  });
  const result = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_list_capabilities, {}, {})).content[0].text);

  assert.deepEqual(result.tools.map((tool) => tool.name), ["ob_list_capabilities"]);
});

test("ob_get_usage_guide returns workflow and dialect notes", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "OB_USER", OB_COMPATIBILITY: "oracle" });
  const server = createObMcpServer(runtime(config));
  const result = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_get_usage_guide, {}, {})).content[0].text);

  assert.equal(result.compatibility, "oracle");
  assert(result.workflow.some((step) => /schemas, tables, columns/i.test(step)));
  assert(result.recommendedTools.includes("ob_prepare_query"));
  assert(result.recommendedTools.includes("ob_generate_er_html"));
  assert(result.safetyRules.some((rule) => /write SQL/i.test(rule)));
  assert(result.dialectNotes.oracle.some((note) => /uppercase/i.test(note)));
});

test("ob_check_opencode_setup returns local OpenCode checks", async () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config));
  const result = JSON.parse((await server.executeToolHandler(server._registeredTools.ob_check_opencode_setup, {}, {})).content[0].text);

  assert.equal(result.defaultProfile, "default");
  assert(result.checks.some((check) => check.id === "local.opencode_config"));
  assert(result.files.config.endsWith("opencode.jsonc"));
});

test("tool manifests declare read-only safety and execution budgets", () => {
  assert.equal(TOOL_CAPABILITIES.length > 80, true);

  for (const tool of TOOL_CAPABILITIES) {
    const manifest = assertToolManifest(tool.name);
    assert.equal(manifest.name, tool.name);
    assert.equal(manifest.readOnly, true);
    assert.match(manifest.since, /^v\d+\.\d+\.\d+$/);
    assert(["metadata", "read_data", "analysis", "local_export"].includes(manifest.operationType));
    assert(["none", "metadata", "query_rows", "sampled_rows", "local_artifact"].includes(manifest.dataTouch));
    assert.equal(typeof manifest.requiresSqlGuard, "boolean");
    assert.equal(typeof manifest.requiresProfilePolicy, "boolean");
    assert.equal(manifest.requiresAuditLog, true);
    assert("maxRows" in manifest.budget);
    assert.equal(typeof manifest.budget.maxBytes, "string");
    assert("maxTables" in manifest.budget);
    assert("maxColumns" in manifest.budget);
    assert.equal(typeof manifest.budget.maxDbCalls, "string");
    assert.equal(typeof manifest.budget.timeoutMs, "string");
    assert.equal(typeof manifest.mysqlSmoke, "boolean");
    assert.equal(typeof manifest.oracleSmoke, "boolean");
    assert.equal(typeof manifest.smoke.mysql, "boolean");
    assert.equal(typeof manifest.smoke.oracle, "boolean");
    assert.equal(manifest.smoke.mysql, manifest.mysqlSmoke);
    assert.equal(manifest.smoke.oracle, manifest.oracleSmoke);
    if (manifest.mode === "all") {
      assert.equal(manifest.mysqlSmoke, true, `${manifest.name} must declare MySQL smoke coverage`);
      assert.equal(manifest.oracleSmoke, true, `${manifest.name} must declare Oracle smoke coverage`);
    }
    if (manifest.operationType === "read_data") {
      assert.equal(manifest.requiresSqlGuard, true, `${manifest.name} must use SQL guard`);
    }
    if (manifest.dataTouch !== "none") {
      assert.equal(manifest.requiresProfilePolicy, true, `${manifest.name} must require profile policy`);
    }
  }
});

test("tool manifest budgets resolve to active profile limits", () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_MAX_ROWS: "37",
    OB_MAX_RESULT_BYTES: "123456",
    OB_MAX_DB_CALLS: "7",
    OB_METADATA_MAX_DB_CALLS: "13",
    OB_QUERY_TIMEOUT_MS: "7000",
    OB_ER_TOTAL_TIMEOUT_MS: "11000",
    OB_ER_MAX_TABLES: "42",
    OB_ER_MAX_COLUMNS_PER_TABLE: "9",
    OB_ER_MAX_RELATIONSHIPS: "88",
    OB_ER_MAX_DB_CALLS: "17"
  });
  const queryBudget = resolveToolBudget("ob_query", config);
  const erBudget = resolveToolBudget("ob_generate_er_html", config);
  const metadataBudget = resolveToolBudget("ob_capture_metadata_snapshot", config);

  assert.deepEqual(queryBudget, {
    maxRows: 37,
    maxBytes: 123456,
    maxTables: null,
    maxColumns: null,
    maxRelationships: null,
    maxDbCalls: 7,
    timeoutMs: 7000
  });
  assert.deepEqual(erBudget, {
    maxRows: null,
    maxBytes: 123456,
    maxTables: 42,
    maxColumns: 9,
    maxRelationships: 88,
    maxDbCalls: 17,
    timeoutMs: 11000
  });
  assert.equal(metadataBudget.maxDbCalls, 13);
});

test("registered MCP tools all have a manifest entry", () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config));
  const registeredTools = Object.keys(server._registeredTools).sort();
  const manifestTools = TOOL_CAPABILITIES.map((tool) => tool.name).sort();

  assert.deepEqual(registeredTools, manifestTools);
});

test("registered MCP resources remain available", () => {
  const config = loadConfig({ OB_ALLOWED_SCHEMAS: "biz_test" });
  const server = createObMcpServer(runtime(config));

  assert.deepEqual(Object.keys(server._registeredResources).sort(), ["ob://connection", "ob://profiles"]);
  assert.deepEqual(Object.keys(server._registeredResourceTemplates).sort(), ["table-schema"]);
});

function runtime(config) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: {
      default: {
        async query() {
          return [[], []];
        }
      }
    },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function compareTools(left, right) {
  const versionOrder = compareVersions(left.since, right.since);
  return versionOrder === 0 ? left.name.localeCompare(right.name) : versionOrder;
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (leftParts[i] !== rightParts[i]) {
      return leftParts[i] - rightParts[i];
    }
  }
  return 0;
}

function parseVersion(value) {
  return value.replace(/^v/, "").split(".").map(Number);
}

function toolSortKey(tool) {
  return `${tool.since}:${tool.name}`;
}
