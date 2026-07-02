import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("tool handler returns a structured timeout error when the pool does not respond", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_QUERY_TIMEOUT_MS: "10"
  });
  const server = createObMcpServer({
    defaultProfile: "default",
    configs: { default: config },
    pools: {
      default: {
        query: () => new Promise(() => {})
      }
    },
    queryLimiters: { default: { active: 0, limit: 1 } },
    metadataCaches: { default: { entries: new Map(), hits: 0, misses: 0, evictions: 0 } }
  });

  const started = Date.now();
  const result = await server.executeToolHandler(server._registeredTools.ob_ping, {}, {});
  const elapsedMs = Date.now() - started;
  const payload = JSON.parse(result.content[0].text);

  assert.equal(result.isError, true);
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /exceeded configured timeout budget/i);
  assert(payload.hints.some((hint) => /Narrow the schema/i.test(hint)));
  assert(elapsedMs < 2_000);
});
