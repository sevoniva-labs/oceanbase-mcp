import assert from "node:assert/strict";
import test from "node:test";

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
  assert(result.workflow.some((step) => /schemas, tables, and columns/i.test(step)));
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
