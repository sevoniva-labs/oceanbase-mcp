import { spawn } from "node:child_process";

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
const selectOneSql = isOracle ? "SELECT 1 AS mcp_ok FROM DUAL" : "SELECT 1 AS mcp_ok";
const requirePartitions = process.env.OB_SMOKE_REQUIRE_PARTITIONS === "true" || isOracle;

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    OB_ALLOWED_SCHEMAS: process.env.OB_ALLOWED_SCHEMAS ?? smokeSchema,
    OB_MASKED_COLUMNS: process.env.OB_MASKED_COLUMNS ?? `${smokeSchema}.${smokeTable}.${smokeMaskedColumn}`,
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
  const permissions = await send("tools/call", { name: "ob_verify_permissions", arguments: {} });
  const policyExplain = await send("tools/call", {
    name: "ob_policy_explain",
    arguments: { sql: "SHOW DATABASES" }
  });
  const queryPreview = await send("tools/call", {
    name: "ob_query_preview",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const ping = await send("tools/call", { name: "ob_ping", arguments: {} });
  const query = await send("tools/call", {
    name: "ob_query",
    arguments: { sql: selectOneSql, maxRows: 5 }
  });
  const pagedQuery = await send("tools/call", {
    name: "ob_query_page",
    arguments: { sql: pageSql, page: 1, pageSize: 2 }
  });
  const explain = await send("tools/call", {
    name: "ob_explain",
    arguments: { sql: selectOneSql, maxRows: 20 }
  });
  const planAnalysis = await send("tools/call", {
    name: "ob_analyze_query_plan",
    arguments: { sql: selectOneSql, maxRows: 20 }
  });
  const performanceReport = await send("tools/call", {
    name: "ob_generate_performance_report",
    arguments: { sql: countSql, maxRows: 20 }
  });
  const catalog = await send("tools/call", {
    name: "ob_search_catalog",
    arguments: { query: smokeSearch, schema: smokeSchema, limit: 20 }
  });
  const objects = await send("tools/call", {
    name: "ob_list_objects",
    arguments: { schema: smokeSchema, limit: 20 }
  });
  const objectListResult = parseToolJson(objects);
  let objectMetadataResult = null;
  if (isOracle && objectListResult.objects.length > 0) {
    const firstObject = objectListResult.objects[0];
    objectMetadataResult = parseToolJson(await send("tools/call", {
      name: "ob_get_object_metadata",
      arguments: {
        schema: smokeSchema,
        objectName: firstObject.object_name ?? firstObject.OBJECT_NAME,
        objectType: toolObjectType(firstObject.object_type ?? firstObject.OBJECT_TYPE)
      }
    }));
  }
  const tableSchema = await send("tools/call", {
    name: "ob_get_table_schema",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const tableDdl = await send("tools/call", {
    name: "ob_get_table_ddl",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const tableContext = await send("tools/call", {
    name: "ob_get_table_context",
    arguments: { schema: smokeSchema, table: smokeTable, sampleLimit: 3 }
  });
  const relatedTables = await send("tools/call", {
    name: "ob_find_related_tables",
    arguments: { schema: smokeSchema, table: smokeTable, depth: 1, limit: 20 }
  });
  const tableStats = await send("tools/call", {
    name: "ob_get_table_stats",
    arguments: { schema: smokeSchema, table: smokeTable }
  });
  const columnProfile = await send("tools/call", {
    name: "ob_profile_columns",
    arguments: { schema: smokeSchema, table: smokeTable, columns: [smokeIdColumn, smokeMaskedColumn], rowLimit: 5, topValues: 2, sampleValues: 2 }
  });
  const queryTemplates = await send("tools/call", {
    name: "ob_generate_query",
    arguments: { schema: smokeSchema, table: smokeTable, maxRows: 20 }
  });
  const erDiagram = await send("tools/call", {
    name: "ob_generate_er_diagram",
    arguments: { schema: smokeSchema, table: smokeTable, depth: 1, maxTables: 10 }
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
  const indexRows = parseToolJson(indexes);
  const constraintRows = parseToolJson(constraints);
  const partitionRows = parseToolJson(partitions);
  const sampleOutput = parseToolJson(sample);
  const blockedWriteResult = parseToolJson(blocked);
  const connectionResourceJson = JSON.parse(connectionResource.contents[0].text);
  const tableResourceRows = JSON.parse(tableResource.contents[0].text);
  const unqualifiedTableRows = parseToolJson(unqualifiedTables);
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
    permissionsOk: Array.isArray(permissionsResult.writablePrivileges),
    policyExplainBlocked: policyExplainResult.allowed === false,
    queryPreviewOk:
      queryPreviewResult.allowed === true &&
      queryPreviewResult.executed === false &&
      queryPreviewResult.explainRun === true &&
      ["low", "medium", "high"].includes(queryPreviewResult.analysis?.riskLevel),
    pingOk: JSON.parse(ping.content[0].text).ok === true,
    queryRows: JSON.parse(query.content[0].text).rows,
    pagedQueryOk:
      pagedQueryResult.executed === true &&
      pagedQueryResult.page === 1 &&
      pagedQueryResult.pageSize === 2 &&
      Array.isArray(pagedQueryResult.rows),
    explainRows: explainOutput.rows.length,
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
    indexRows: indexRows.length,
    constraintRows: constraintRows.length,
    partitionRows: partitionRows.length,
    partitionsOk: !requirePartitions || partitionRows.length > 0,
    sampleRows: sampleOutput.rows.length,
    sampleMaskOk: sampleOutput.rows.every((row) => row[smokeMaskedColumn] === "***MASKED***"),
    enterpriseTools: expectedEnterpriseTools.every((name) => toolNames.includes(name)),
    resourcesOk:
      resources.resources.some((resource) => resource.uri === "ob://connection") &&
      resourceTemplates.resourceTemplates.some((template) => template.uriTemplate === "ob://profile/{profile}/schema/{schema}/table/{table}") &&
      connectionResourceJson.profile === defaultProfile &&
      tableResourceRows.length === tableSchemaRows.length,
    blockedWrite: blocked.isError === true,
    errorHintsOk: Array.isArray(blockedWriteResult.hints) && blockedWriteResult.hints.length > 0,
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
    !output.permissionsOk ||
    !output.policyExplainBlocked ||
    !output.queryPreviewOk ||
    !output.pingOk ||
    !output.pagedQueryOk ||
    !output.enterpriseTools ||
    !output.resourcesOk ||
    !output.planAnalysisOk ||
    !output.performanceReportOk ||
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
    !output.partitionsOk ||
    output.sampleRows < 1 ||
    !output.sampleMaskOk ||
    !output.blockedWrite ||
    !output.errorHintsOk ||
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

function toolObjectType(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}
