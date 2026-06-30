import { spawn } from "node:child_process";

const compatibility = (process.env.OB_COMPATIBILITY ?? "mysql").toLowerCase();
const isOracle = compatibility === "oracle";
const smokeSchema = process.env.OB_SMOKE_SCHEMA ?? (isOracle ? "OB_USER" : "biz_test");
const smokeTable = process.env.OB_SMOKE_TABLE ?? (isOracle ? "OB_MCP_SMOKE_SAMPLE" : "ob_sample");
const smokeSearch = process.env.OB_SMOKE_SEARCH ?? smokeTable;
const smokeIdColumn = process.env.OB_SMOKE_ID_COLUMN ?? (isOracle ? "ID" : "id");
const qualifiedTable = `${smokeSchema}.${smokeTable}`;
const selectOneSql = isOracle ? "SELECT 1 AS mcp_ok FROM DUAL" : "SELECT 1 AS mcp_ok";
const requirePartitions = process.env.OB_SMOKE_REQUIRE_PARTITIONS === "true" || isOracle;

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OB_ALLOWED_SCHEMAS: process.env.OB_ALLOWED_SCHEMAS ?? smokeSchema,
    OB_ALLOW_SELECT_STAR: "false"
  },
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = "";
let nextId = 1;
const pending = new Map();

const timer = setTimeout(() => {
  console.error("MCP smoke timed out");
  child.kill("SIGKILL");
  process.exit(1);
}, 120_000);

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) {
      break;
    }

    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) {
      continue;
    }

    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ob-mcp-smoke", version: "0.0.0" }
  });
  notify("notifications/initialized", {});

  const tools = await send("tools/list", {});
  const toolNames = tools.tools.map((tool) => tool.name);
  const profiles = await send("tools/call", { name: "ob_list_profiles", arguments: {} });
  const profileResult = parseToolJson(profiles);
  const defaultProfile = profileResult.defaultProfile;
  const diagnostics = await send("tools/call", { name: "ob_config_diagnostics", arguments: {} });
  const policyExplain = await send("tools/call", {
    name: "ob_policy_explain",
    arguments: { sql: "SHOW DATABASES" }
  });
  const ping = await send("tools/call", { name: "ob_ping", arguments: {} });
  const query = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: selectOneSql, maxRows: 5 }
  });
  const explain = await send("tools/call", {
    name: "ob_explain",
    arguments: { sql: selectOneSql, maxRows: 20 }
  });
  const catalog = await send("tools/call", {
    name: "ob_search_catalog",
    arguments: { query: smokeSearch, schema: smokeSchema, limit: 20 }
  });
  const tableSchema = await send("tools/call", {
    name: "ob_get_table_schema",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const indexes = await send("tools/call", {
    name: "ob_get_indexes",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const constraints = await send("tools/call", {
    name: "ob_get_constraints",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const partitions = await send("tools/call", {
    name: "ob_get_partitions",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const sample = await send("tools/call", {
    name: "ob_sample_rows",
    arguments: { schema: smokeSchema, table: smokeTable, limit: 3 }
  });
  const resources = await send("resources/list", {});
  const resourceTemplates = await send("resources/templates/list", {});
  const connectionResource = await send("resources/read", { uri: "ob://connection" });
  const tableResource = await send("resources/read", {
    uri: `ob://profile/${defaultProfile}/schema/${smokeSchema}/table/${smokeTable}`
  });
  const blocked = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: "DROP TABLE definitely_blocked" }
  });
  const blockedStar = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: `SELECT * FROM ${qualifiedTable}` }
  });
  const blockedShow = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: "SHOW DATABASES" }
  });
  const blockedExplainWrite = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: `EXPLAIN UPDATE ${qualifiedTable} SET ${smokeIdColumn} = ${smokeIdColumn}` }
  });
  const blockedExecutableComment = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: "SELECT 0 AS id /*!50000 UNION ALL SELECT password FROM mysql.user */" }
  });
  const blockedParenthesizedRef = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: "SELECT User FROM (mysql.user)" }
  });
  const blockedDistinctrowStar = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: `SELECT DISTINCTROW * FROM ${qualifiedTable}` }
  });
  const unqualifiedTables = await send("tools/call", {
    name: "ob_list_tables",
    arguments: {}
  });
  const diagnosticsResult = parseToolJson(diagnostics);
  const policyExplainResult = parseToolJson(policyExplain);
  const catalogRows = parseToolJson(catalog);
  const explainOutput = parseToolJson(explain);
  const tableSchemaRows = parseToolJson(tableSchema);
  const indexRows = parseToolJson(indexes);
  const constraintRows = parseToolJson(constraints);
  const partitionRows = parseToolJson(partitions);
  const sampleOutput = parseToolJson(sample);
  const connectionResourceJson = JSON.parse(connectionResource.contents[0].text);
  const tableResourceRows = JSON.parse(tableResource.contents[0].text);
  const unqualifiedTableRows = parseToolJson(unqualifiedTables);
  const expectedEnterpriseTools = [
    "ob_list_profiles",
    "ob_config_diagnostics",
    "ob_policy_explain",
    "ob_search_catalog",
    "ob_get_table_schema",
    "ob_get_indexes",
    "ob_get_constraints",
    "ob_get_partitions",
    "ob_sample_rows"
  ];

  const output = {
    server: init.serverInfo,
    toolNames,
    profilesOk: profileResult.defaultProfile === defaultProfile && Boolean(profileResult.profiles?.[defaultProfile]),
    diagnosticsOk: diagnosticsResult.ok === true,
    policyExplainBlocked: policyExplainResult.allowed === false,
    pingOk: JSON.parse(ping.content[0].text).ok === true,
    queryRows: JSON.parse(query.content[0].text).rows,
    explainRows: explainOutput.rows.length,
    catalogRows: catalogRows.length,
    tableSchemaRows: tableSchemaRows.length,
    indexRows: indexRows.length,
    constraintRows: constraintRows.length,
    partitionRows: partitionRows.length,
    partitionsOk: !requirePartitions || partitionRows.length > 0,
    sampleRows: sampleOutput.rows.length,
    enterpriseTools: expectedEnterpriseTools.every((name) => toolNames.includes(name)),
    resourcesOk:
      resources.resources.some((resource) => resource.uri === "ob://connection") &&
      resourceTemplates.resourceTemplates.some((template) => template.uriTemplate === "ob://profile/{profile}/schema/{schema}/table/{table}") &&
      connectionResourceJson.profile === defaultProfile &&
      tableResourceRows.length === tableSchemaRows.length,
    blockedWrite: blocked.isError === true,
    blockedSelectStar: blockedStar.isError === true,
    blockedShow: blockedShow.isError === true,
    blockedExplainWrite: blockedExplainWrite.isError === true,
    blockedExecutableComment: blockedExecutableComment.isError === true,
    blockedParenthesizedRef: blockedParenthesizedRef.isError === true,
    blockedDistinctrowStar: blockedDistinctrowStar.isError === true,
    noSchemaSampleLeak: !JSON.stringify(unqualifiedTableRows).includes("schemaSample"),
    noWriteTool: !tools.tools.some((tool) => tool.name === "ob_execute")
  };

  if (
    !output.profilesOk ||
    !output.diagnosticsOk ||
    !output.policyExplainBlocked ||
    !output.pingOk ||
    !output.enterpriseTools ||
    !output.resourcesOk ||
    output.catalogRows < 1 ||
    output.explainRows < 1 ||
    output.tableSchemaRows < 1 ||
    !output.partitionsOk ||
    output.sampleRows < 1 ||
    !output.blockedWrite ||
    !output.blockedSelectStar ||
    !output.blockedShow ||
    !output.blockedExplainWrite ||
    !output.blockedExecutableComment ||
    !output.blockedParenthesizedRef ||
    !output.blockedDistinctrowStar ||
    !output.noSchemaSampleLeak ||
    !output.noWriteTool
  ) {
    throw new Error(`Unexpected MCP smoke result: ${JSON.stringify(output)}`);
  }

  console.log(JSON.stringify(output, null, 2));
} finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill("SIGTERM");
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text);
}
