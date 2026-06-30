import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = process.env.OB_MCP_PORT ?? "3317";
const token = process.env.OB_MCP_AUTH_TOKEN ?? "local-http-smoke-token";
const scopedToken = process.env.OB_MCP_SCOPED_AUTH_TOKEN ?? "local-http-smoke-scoped-token";
const url = `http://127.0.0.1:${port}/mcp`;
const compatibility = (process.env.OB_COMPATIBILITY ?? "mysql").toLowerCase();
const isOracle = compatibility === "oracle";
const smokeSchema = process.env.OB_SMOKE_SCHEMA ?? (isOracle ? "OB_USER" : "biz_test");
const smokeTable = process.env.OB_SMOKE_TABLE ?? (isOracle ? "OB_MCP_SMOKE_SAMPLE" : "ob_sample");
const smokeSearch = process.env.OB_SMOKE_SEARCH ?? smokeTable;
const smokeIdColumn = process.env.OB_SMOKE_ID_COLUMN ?? (isOracle ? "ID" : "id");
const qualifiedTable = `${smokeSchema}.${smokeTable}`;
const countSql = `SELECT COUNT(${smokeIdColumn}) AS row_count FROM ${qualifiedTable}`;
const requirePartitions = process.env.OB_SMOKE_REQUIRE_PARTITIONS === "true" || isOracle;

const child = spawn(process.execPath, ["dist/http.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OB_MCP_HOST: "127.0.0.1",
    OB_MCP_PORT: port,
    OB_MCP_AUTH_TOKEN: token,
    OB_MCP_AUTH_TOKENS: JSON.stringify([
      {
        name: "scoped-smoke",
        token: scopedToken,
        profiles: ["default"],
        tools: ["ob_query", "ob_list_tables"]
      }
    ]),
    OB_MCP_ALLOWED_IPS: process.env.OB_MCP_ALLOWED_IPS ?? "127.0.0.1,::1",
    OB_MCP_TRUST_PROXY: process.env.OB_MCP_TRUST_PROXY ?? "true",
    OB_ALLOWED_SCHEMAS: process.env.OB_ALLOWED_SCHEMAS ?? smokeSchema,
    OB_ALLOW_SELECT_STAR: "false"
  },
  stdio: ["ignore", "ignore", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const timer = setTimeout(() => {
  console.error(stderr);
  child.kill("SIGKILL");
  process.exit(1);
}, 120_000);

try {
  const health = await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });
  const forbiddenIp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-forwarded-for": "203.0.113.99"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
  });

  const client = new Client({ name: "ob-mcp-http-smoke", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  const profiles = await client.callTool({ name: "ob_list_profiles", arguments: {} });
  const profileResult = parseToolJson(profiles);
  const defaultProfile = profileResult.defaultProfile;
  const diagnostics = await client.callTool({ name: "ob_config_diagnostics", arguments: {} });
  const permissions = await client.callTool({ name: "ob_verify_permissions", arguments: {} });
  const policyExplain = await client.callTool({
    name: "ob_policy_explain",
    arguments: { sql: "SHOW DATABASES" }
  });
  const query = await client.callTool({
    name: "ob_query",
    arguments: { sql: countSql }
  });
  const explain = await client.callTool({
    name: "ob_explain",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const catalog = await client.callTool({
    name: "ob_search_catalog",
    arguments: { query: smokeSearch, schema: smokeSchema, limit: 20 }
  });
  const tableSchema = await client.callTool({
    name: "ob_get_table_schema",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const tableDdl = await client.callTool({
    name: "ob_get_table_ddl",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const indexes = await client.callTool({
    name: "ob_get_indexes",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const constraints = await client.callTool({
    name: "ob_get_constraints",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const partitions = await client.callTool({
    name: "ob_get_partitions",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const sample = await client.callTool({
    name: "ob_sample_rows",
    arguments: { schema: smokeSchema, table: smokeTable, limit: 3 }
  });
  const resources = await client.listResources();
  const resourceTemplates = await client.listResourceTemplates();
  const connectionResource = await client.readResource({ uri: "ob://connection" });
  const tableResource = await client.readResource({
    uri: `ob://profile/${defaultProfile}/schema/${smokeSchema}/table/${smokeTable}`
  });
  const blockedStar = await client.callTool({
    name: "ob_query",
    arguments: { sql: `SELECT * FROM ${qualifiedTable}` }
  });
  const blockedShow = await client.callTool({
    name: "ob_query",
    arguments: { sql: "SHOW TABLES FROM mysql" }
  });
  const blockedExplainWrite = await client.callTool({
    name: "ob_query",
    arguments: { sql: `EXPLAIN UPDATE ${qualifiedTable} SET ${smokeIdColumn} = ${smokeIdColumn}` }
  });
  const blockedExecutableComment = await client.callTool({
    name: "ob_query",
    arguments: { sql: "SELECT 0 AS id /*!50000 UNION ALL SELECT password FROM mysql.user */" }
  });
  const blockedParenthesizedRef = await client.callTool({
    name: "ob_query",
    arguments: { sql: "SELECT User FROM (mysql.user)" }
  });
  const blockedDistinctrowStar = await client.callTool({
    name: "ob_query",
    arguments: { sql: `SELECT DISTINCTROW * FROM ${qualifiedTable}` }
  });
  const unqualifiedTables = await client.callTool({
    name: "ob_list_tables",
    arguments: {}
  });
  await client.close();
  const scopedClient = new Client({ name: "ob-mcp-http-scoped-smoke", version: "0.0.0" });
  const scopedTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${scopedToken}`
      }
    }
  });
  await scopedClient.connect(scopedTransport);
  const scopedTools = await scopedClient.listTools();
  const scopedToolNames = scopedTools.tools.map((tool) => tool.name);
  await scopedClient.close();
  const diagnosticsResult = parseToolJson(diagnostics);
  const permissionsResult = parseToolJson(permissions);
  const policyExplainResult = parseToolJson(policyExplain);
  const catalogRows = parseToolJson(catalog);
  const explainOutput = parseToolJson(explain);
  const tableSchemaRows = parseToolJson(tableSchema);
  const tableDdlResult = parseToolJson(tableDdl);
  const indexRows = parseToolJson(indexes);
  const constraintRows = parseToolJson(constraints);
  const partitionRows = parseToolJson(partitions);
  const sampleOutput = parseToolJson(sample);
  const connectionResourceJson = JSON.parse(connectionResource.contents[0].text);
  const tableResourceRows = JSON.parse(tableResource.contents[0].text);
  const unqualifiedTableRows = parseToolJson(unqualifiedTables);
  const metricsText = await metrics.text();
  const expectedEnterpriseTools = [
    "ob_list_profiles",
    "ob_config_diagnostics",
    "ob_verify_permissions",
    "ob_policy_explain",
    "ob_search_catalog",
    "ob_get_table_schema",
    "ob_get_table_ddl",
    "ob_get_indexes",
    "ob_get_constraints",
    "ob_get_partitions",
    "ob_sample_rows"
  ];

  const output = {
    toolNames,
    healthOk: health.ok === true && health.mode === "http" && Number.isInteger(health.profileCount),
    metricsOk: metrics.ok && metricsText.includes("ob_mcp_http_requests_total"),
    unauthorizedStatus: unauthorized.status,
    forbiddenIpStatus: forbiddenIp.status,
    query: JSON.parse(query.content[0].text).rows,
    explainRows: explainOutput.rows.length,
    profilesOk: profileResult.defaultProfile === defaultProfile && Boolean(profileResult.profiles?.[defaultProfile]),
    diagnosticsOk: diagnosticsResult.ok === true,
    permissionsOk: Array.isArray(permissionsResult.writablePrivileges),
    policyExplainBlocked: policyExplainResult.allowed === false,
    catalogRows: catalogRows.length,
    tableSchemaRows: tableSchemaRows.length,
    tableDdlOk: typeof tableDdlResult.ddl === "string" && tableDdlResult.ddl.includes(smokeTable),
    indexRows: indexRows.length,
    constraintRows: constraintRows.length,
    partitionRows: partitionRows.length,
    partitionsOk: !requirePartitions || partitionRows.length > 0,
    sampleRows: sampleOutput.rows.length,
    enterpriseTools: expectedEnterpriseTools.every((name) => toolNames.includes(name)),
    scopedToolsOk:
      scopedToolNames.length === 2 &&
      scopedToolNames.includes("ob_query") &&
      scopedToolNames.includes("ob_list_tables"),
    resourcesOk:
      resources.resources.some((resource) => resource.uri === "ob://connection") &&
      resourceTemplates.resourceTemplates.some((template) => template.uriTemplate === "ob://profile/{profile}/schema/{schema}/table/{table}") &&
      connectionResourceJson.profile === defaultProfile &&
      tableResourceRows.length === tableSchemaRows.length,
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
    !output.healthOk ||
    !output.metricsOk ||
    output.unauthorizedStatus !== 401 ||
    output.forbiddenIpStatus !== 403 ||
    !output.profilesOk ||
    !output.diagnosticsOk ||
    !output.permissionsOk ||
    !output.policyExplainBlocked ||
    !output.enterpriseTools ||
    !output.scopedToolsOk ||
    !output.resourcesOk ||
    output.catalogRows < 1 ||
    output.explainRows < 1 ||
    output.tableSchemaRows < 1 ||
    !output.tableDdlOk ||
    !output.partitionsOk ||
    output.sampleRows < 1 ||
    !output.blockedSelectStar ||
    !output.blockedShow ||
    !output.blockedExplainWrite ||
    !output.blockedExecutableComment ||
    !output.blockedParenthesizedRef ||
    !output.blockedDistinctrowStar ||
    !output.noSchemaSampleLeak ||
    !output.noWriteTool
  ) {
    throw new Error(`Unexpected HTTP MCP smoke result: ${JSON.stringify(output)}`);
  }

  console.log(JSON.stringify(output, null, 2));
} finally {
  clearTimeout(timer);
  child.kill("SIGTERM");
}

async function waitForHealth(healthUrl) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP MCP server did not become healthy. stderr=${stderr}`);
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text);
}
