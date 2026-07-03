#!/usr/bin/env node
import "dotenv/config";

import { loadConfig, publicConfig } from "./config.js";
import { createObPool, listSchemas, ping, runQuery } from "./db.js";
import { jsonText } from "./format.js";

const config = loadConfig();
const pool = createObPool(config);

try {
  const pingResult = await ping(pool, config);
  const selectSql = config.compatibility === "oracle" ? "SELECT 1 AS smoke_ok FROM DUAL" : "SELECT 1 AS smoke_ok";
  const queryResult = await runQuery(pool, selectSql, [], config.maxRows, config.queryTimeoutMs);
  const schemas = await listSchemas(pool, config.compatibility, config.queryTimeoutMs);

  console.log(
    jsonText({
      config: publicConfig(config),
      ping: { ok: pingResult.ok === true },
      query: {
        ok: queryResult.rowCount > 0,
        rowCount: queryResult.rowCount,
        fieldCount: queryResult.fields?.length ?? 0,
        truncated: queryResult.truncated
      },
      schemaCount: schemas.length
    })
  );
} finally {
  await pool.end();
}
