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
const smokeMaskedColumn = process.env.OB_SMOKE_MASKED_COLUMN ?? (isOracle ? "NAME" : "name");
const qualifiedTable = `${smokeSchema}.${smokeTable}`;
const countSql = `SELECT COUNT(${smokeIdColumn}) AS row_count FROM ${qualifiedTable}`;
const pageSql = `SELECT ${smokeIdColumn} AS smoke_id FROM ${qualifiedTable} ORDER BY ${smokeIdColumn}`;
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
    OB_MASKED_COLUMNS: process.env.OB_MASKED_COLUMNS ?? `${smokeSchema}.${smokeTable}.${smokeMaskedColumn}`,
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
  const queryPreview = await client.callTool({
    name: "ob_query_preview",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const query = await client.callTool({
    name: "ob_query",
    arguments: { sql: countSql }
  });
  const pagedQuery = await client.callTool({
    name: "ob_query_page",
    arguments: { sql: pageSql, page: 1, pageSize: 2 }
  });
  const explain = await client.callTool({
    name: "ob_explain",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const planAnalysis = await client.callTool({
    name: "ob_analyze_query_plan",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const performanceReport = await client.callTool({
    name: "ob_generate_performance_report",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const catalog = await client.callTool({
    name: "ob_search_catalog",
    arguments: { query: smokeSearch, schema: smokeSchema, limit: 20 }
  });
  const objects = await client.callTool({
    name: "ob_list_objects",
    arguments: { schema: smokeSchema, limit: 20 }
  });
  const objectListResult = parseToolJson(objects);
  let objectMetadataResult = null;
  if (isOracle && objectListResult.objects.length > 0) {
    const firstObject = objectListResult.objects[0];
    objectMetadataResult = parseToolJson(await client.callTool({
      name: "ob_get_object_metadata",
      arguments: {
        schema: smokeSchema,
        objectName: firstObject.object_name ?? firstObject.OBJECT_NAME,
        objectType: toolObjectType(firstObject.object_type ?? firstObject.OBJECT_TYPE)
      }
    }));
  }
  const tableSchema = await client.callTool({
    name: "ob_get_table_schema",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const tableDdl = await client.callTool({
    name: "ob_get_table_ddl",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const tableContext = await client.callTool({
    name: "ob_get_table_context",
    arguments: { schema: smokeSchema, table: smokeTable, sampleLimit: 3 }
  });
  const relatedTables = await client.callTool({
    name: "ob_find_related_tables",
    arguments: { schema: smokeSchema, table: smokeTable, depth: 1, limit: 20 }
  });
  const tableStats = await client.callTool({
    name: "ob_get_table_stats",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const columnProfile = await client.callTool({
    name: "ob_profile_columns",
    arguments: { schema: smokeSchema, table: smokeTable, columns: [smokeIdColumn, smokeMaskedColumn], rowLimit: 5, topValues: 2, sampleValues: 2 }
  });
  const queryTemplates = await client.callTool({
    name: "ob_generate_query",
    arguments: { schema: smokeSchema, table: smokeTable, maxRows: 20 }
  });
  const erDiagram = await client.callTool({
    name: "ob_generate_er_diagram",
    arguments: { schema: smokeSchema, table: smokeTable, depth: 1, maxTables: 10 }
  });
  const erPlan = await client.callTool({
    name: "ob_plan_er_export",
    arguments: { schema: smokeSchema, table: smokeTable, format: "html-interactive", includeInferred: false, maxTables: 5, chunkSize: 2, outputDir: "tmp/er-smoke" }
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
  const queryPreviewResult = parseToolJson(queryPreview);
  const pagedQueryResult = parseToolJson(pagedQuery);
  const catalogRows = parseToolJson(catalog);
  const explainOutput = parseToolJson(explain);
  const planAnalysisResult = parseToolJson(planAnalysis);
  const performanceReportResult = parseToolJson(performanceReport);
  const tableSchemaRows = parseToolJson(tableSchema);
  const tableDdlResult = parseToolJson(tableDdl);
  const tableContextResult = parseToolJson(tableContext);
  const relatedTablesResult = parseToolJson(relatedTables);
  const tableStatsResult = parseToolJson(tableStats);
  const columnProfileResult = parseToolJson(columnProfile);
  const queryTemplateResult = parseToolJson(queryTemplates);
  const erDiagramResult = parseToolJson(erDiagram);
  const erPlanResult = parseToolJson(erPlan);
  const indexRows = parseToolJson(indexes);
  const constraintRows = parseToolJson(constraints);
  const partitionRows = parseToolJson(partitions);
  const sampleOutput = parseToolJson(sample);
  const blockedStarResult = parseToolJson(blockedStar);
  const connectionResourceJson = JSON.parse(connectionResource.contents[0].text);
  const tableResourceRows = JSON.parse(tableResource.contents[0].text);
  const unqualifiedTableRows = parseToolJson(unqualifiedTables);
  const metricsText = await metrics.text();
  const expectedEnterpriseTools = [
    "ob_list_profiles",
    "ob_config_diagnostics",
    "ob_verify_permissions",
    "ob_policy_explain",
    "ob_query_preview",
    "ob_query_page",
    "ob_analyze_query_plan",
    "ob_generate_performance_report",
    "ob_search_catalog",
    "ob_search_business_glossary",
    "ob_list_objects",
    "ob_get_object_metadata",
    "ob_get_table_schema",
    "ob_get_table_ddl",
    "ob_get_table_context",
    "ob_find_related_tables",
    "ob_get_table_stats",
    "ob_profile_columns",
    "ob_generate_query",
    "ob_generate_er_diagram",
    "ob_plan_er_export",
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
    pagedQueryOk:
      pagedQueryResult.executed === true &&
      pagedQueryResult.page === 1 &&
      pagedQueryResult.pageSize === 2 &&
      Array.isArray(pagedQueryResult.rows),
    explainRows: explainOutput.rows.length,
    profilesOk: profileResult.defaultProfile === defaultProfile && Boolean(profileResult.profiles?.[defaultProfile]),
    diagnosticsOk: diagnosticsResult.ok === true,
    permissionsOk: Array.isArray(permissionsResult.writablePrivileges),
    policyExplainBlocked: policyExplainResult.allowed === false,
    queryPreviewOk:
      queryPreviewResult.allowed === true &&
      queryPreviewResult.executed === false &&
      queryPreviewResult.explainRun === true &&
      ["low", "medium", "high"].includes(queryPreviewResult.analysis?.riskLevel),
    planAnalysisOk: ["low", "medium", "high"].includes(planAnalysisResult.analysis?.riskLevel),
    performanceReportOk:
      performanceReportResult.executed === false &&
      ["low", "medium", "high"].includes(performanceReportResult.report?.riskLevel) &&
      performanceReportResult.tables.length > 0,
    catalogRows: catalogRows.length,
    objectListOk: isOracle ? objectListResult.objects.length > 0 : objectListResult.warnings?.length > 0,
    objectMetadataOk: !isOracle || objectMetadataResult?.schema === smokeSchema,
    tableSchemaRows: tableSchemaRows.length,
    tableDdlOk: typeof tableDdlResult.ddl === "string" && tableDdlResult.ddl.includes(smokeTable),
    tableContextOk:
      tableContextResult.table === smokeTable &&
      Array.isArray(tableContextResult.columns) &&
      tableContextResult.columns.length > 0 &&
      tableContextResult.sample?.rows?.length > 0,
    relatedTablesOk: Array.isArray(relatedTablesResult.relations),
    tableStatsOk: Number.isInteger(tableStatsResult.counts?.columns),
    columnProfileOk:
      columnProfileResult.table === smokeTable &&
      columnProfileResult.columns.length > 0 &&
      columnProfileResult.columns.some((column) => column.column === smokeMaskedColumn && column.masked === true),
    queryTemplatesOk:
      queryTemplateResult.executed === false &&
      queryTemplateResult.templates.length > 0 &&
      queryTemplateResult.templates.every((template) => template.policy?.allowed === true),
    erDiagramOk: typeof erDiagramResult.mermaid === "string" && erDiagramResult.mermaid.includes("erDiagram"),
    erPlanOk:
      erPlanResult.format === "html-interactive" &&
      erPlanResult.chunkCount >= 1 &&
      erPlanResult.chunks.every((chunk) => chunk.command.includes("ob-mcp export-er")),
    indexRows: indexRows.length,
    constraintRows: constraintRows.length,
    partitionRows: partitionRows.length,
    partitionsOk: !requirePartitions || partitionRows.length > 0,
    sampleRows: sampleOutput.rows.length,
    sampleMaskOk: sampleOutput.rows.every((row) => row[smokeMaskedColumn] === "***MASKED***"),
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
    errorHintsOk: Array.isArray(blockedStarResult.hints) && blockedStarResult.hints.length > 0,
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
    !output.queryPreviewOk ||
    !output.pagedQueryOk ||
    !output.planAnalysisOk ||
    !output.performanceReportOk ||
    !output.enterpriseTools ||
    !output.scopedToolsOk ||
    !output.resourcesOk ||
    output.catalogRows < 1 ||
    !output.objectListOk ||
    !output.objectMetadataOk ||
    output.explainRows < 1 ||
    output.tableSchemaRows < 1 ||
    !output.tableDdlOk ||
    !output.tableContextOk ||
    !output.relatedTablesOk ||
    !output.tableStatsOk ||
    !output.columnProfileOk ||
    !output.queryTemplatesOk ||
    !output.erDiagramOk ||
    !output.erPlanOk ||
    !output.partitionsOk ||
    output.sampleRows < 1 ||
    !output.sampleMaskOk ||
    !output.blockedSelectStar ||
    !output.errorHintsOk ||
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

function toolObjectType(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}
