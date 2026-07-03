import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("ob_get_object_metadata filters arguments and redacts source preview", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_DENIED_COLUMNS: "P_SECRET_TOKEN,secret_token"
  });
  const server = createObMcpServer(runtime(config, oracleProcedurePool()));

  const result = await server.executeToolHandler(server._registeredTools.ob_get_object_metadata, {
    schema: "APP",
    objectName: "DO_WORK",
    objectType: "procedure"
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.objectType, "PROCEDURE");
  assert.equal(output.policyFiltered, true);
  assert.deepEqual(output.arguments.map((row) => row.ARGUMENT_NAME), ["P_ID"]);
  assert.match(output.sourcePreview.text, /\*\*\*MASKED\*\*\*/);
  assert.doesNotMatch(output.sourcePreview.text, /secret_token/i);
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function oracleProcedurePool() {
  return {
    async query({ sql }) {
      if (/FROM all_objects/i.test(sql)) {
        return [[{
          OWNER: "APP",
          OBJECT_NAME: "DO_WORK",
          OBJECT_TYPE: "PROCEDURE",
          STATUS: "VALID"
        }], []];
      }
      if (/FROM all_arguments/i.test(sql)) {
        return [[
          {
            OWNER: "APP",
            OBJECT_NAME: "DO_WORK",
            ARGUMENT_NAME: "P_ID",
            POSITION: 1,
            DATA_TYPE: "NUMBER",
            IN_OUT: "IN"
          },
          {
            OWNER: "APP",
            OBJECT_NAME: "DO_WORK",
            ARGUMENT_NAME: "P_SECRET_TOKEN",
            POSITION: 2,
            DATA_TYPE: "VARCHAR2",
            IN_OUT: "IN"
          }
        ], []];
      }
      if (/FROM all_source/i.test(sql)) {
        return [[
          { OWNER: "APP", NAME: "DO_WORK", TYPE: "PROCEDURE", LINE: 1, TEXT: "PROCEDURE do_work(p_id IN NUMBER) IS\n" },
          { OWNER: "APP", NAME: "DO_WORK", TYPE: "PROCEDURE", LINE: 2, TEXT: "BEGIN secret_token := 'value'; END;\n" }
        ], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
