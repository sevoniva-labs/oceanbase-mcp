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
  const oracleObjects = Array.isArray(objectListResult.objects) ? objectListResult.objects : [];
  let objectMetadataResult = null;
  if (isOracle && oracleObjects.length > 0) {
    const firstObject = oracleObjects[0];
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
  const schemaMap = await send("tools/call", {
    name: "ob_get_schema_map",
    arguments: { schema: smokeSchema, tablePattern: smokeTable, includeRelationships: false, maxTables: 5, maxColumnsPerTable: 5 }
  });
  const preparedQuery = await send("tools/call", {
    name: "ob_prepare_query",
    arguments: { question: `show recent rows from ${smokeTable}`, schema: smokeSchema, table: smokeTable }
  });
  const builtSelect = await send("tools/call", {
    name: "ob_build_select",
    arguments: {
      schema: smokeSchema,
      table: smokeTable,
      columns: [smokeIdColumn],
      orderBy: [{ column: smokeIdColumn, direction: "asc" }],
      pageSize: 2,
      page: 1
    }
  });
  const sqlLint = await send("tools/call", {
    name: "ob_lint_sql",
    arguments: { sql: pageSql, runExplain: false }
  });
  const querySessionStart = await send("tools/call", {
    name: "ob_start_query_session",
    arguments: {
      schema: smokeSchema,
      table: smokeTable,
      columns: [smokeIdColumn],
      sql: pageSql,
      page: 1,
      pageSize: 2,
      orderBy: smokeIdColumn
    }
  });
  const querySessionStartResult = parseToolJson(querySessionStart);
  const querySessionRead = await send("tools/call", {
    name: "ob_get_query_session",
    arguments: { sessionId: querySessionStartResult.sessionId }
  });
  const querySessionClose = await send("tools/call", {
    name: "ob_close_query_session",
    arguments: { sessionId: querySessionStartResult.sessionId }
  });
  const erHtml = await send("tools/call", {
    name: "ob_generate_er_html",
    arguments: { schema: smokeSchema, table: smokeTable, format: "html-static", includeInferred: false, maxTables: 5 }
  });
  const erPlan = await send("tools/call", {
    name: "ob_plan_er_export",
    arguments: { schema: smokeSchema, table: smokeTable, format: "html-interactive", includeInferred: false, maxTables: 5, chunkSize: 2, outputDir: "tmp/er-smoke" }
  });
  const databaseDictionary = await send("tools/call", {
    name: "ob_get_database_dictionary",
    arguments: { schema: smokeSchema, tablePattern: smokeTable, format: "json", maxTables: 5, maxColumnsPerTable: 5 }
  });
  const metadataSnapshot = await send("tools/call", {
    name: "ob_capture_metadata_snapshot",
    arguments: {
      schema: smokeSchema,
      tablePattern: smokeTable,
      includeRelationships: false,
      includeOracleObjects: isOracle,
      maxTables: 5,
      maxColumnsPerTable: 10,
      maxObjects: 10,
      maxRelationships: 20
    }
  });
  const metadataSnapshotResult = parseToolJson(metadataSnapshot);
  const changedSnapshot = changedSmokeSnapshot(metadataSnapshotResult);
  const sqlUsageIndex = smokeSqlUsageIndex();
  const metadataDiff = await send("tools/call", {
    name: "ob_compare_metadata_snapshots",
    arguments: {
      beforeSnapshot: metadataSnapshotResult,
      afterSnapshot: changedSnapshot,
      changedOnly: true
    }
  });
  const metadataDiffResult = parseToolJson(metadataDiff);
  const sqlUsages = await send("tools/call", {
    name: "ob_find_sql_usages",
    arguments: { sqlIndex: sqlUsageIndex, schema: smokeSchema, table: smokeTable, maxResults: 10 }
  });
  const changeSqlImpact = await send("tools/call", {
    name: "ob_analyze_change_sql_impact",
    arguments: { metadataDiff: metadataDiffResult, sqlIndex: sqlUsageIndex, maxResults: 20 }
  });
  const metadataImpact = await send("tools/call", {
    name: "ob_analyze_metadata_impact",
    arguments: { metadataDiff: metadataDiffResult, sqlIndex: sqlUsageIndex, maxResults: 20 }
  });
  const metadataReport = await send("tools/call", {
    name: "ob_generate_metadata_change_report",
    arguments: {
      metadataDiff: metadataDiffResult,
      impact: parseToolJson(metadataImpact),
      title: "MCP Smoke Metadata Change Report",
      format: isOracle ? "html" : "markdown"
    }
  });
  const sqlSnippetValidation = await send("tools/call", {
    name: "ob_validate_sql_snippet",
    arguments: { schema: smokeSchema, sql: pageSql }
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
  const schemaMapResult = parseToolJson(schemaMap);
  const preparedQueryResult = parseToolJson(preparedQuery);
  const builtSelectResult = parseToolJson(builtSelect);
  const sqlLintResult = parseToolJson(sqlLint);
  const querySessionReadResult = parseToolJson(querySessionRead);
  const querySessionCloseResult = parseToolJson(querySessionClose);
  const erHtmlResult = parseToolJson(erHtml);
  const erPlanResult = parseToolJson(erPlan);
  const databaseDictionaryResult = parseToolJson(databaseDictionary);
  const sqlUsageResult = parseToolJson(sqlUsages);
  const changeSqlImpactResult = parseToolJson(changeSqlImpact);
  const metadataImpactResult = parseToolJson(metadataImpact);
  const metadataReportResult = parseToolJson(metadataReport);
  const sqlSnippetValidationResult = parseToolJson(sqlSnippetValidation);
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
    "ob_plan_er_export",
    "ob_get_schema_map",
    "ob_prepare_query",
    "ob_build_select",
    "ob_lint_sql",
    "ob_start_query_session",
    "ob_get_query_session",
    "ob_close_query_session",
    "ob_generate_er_html",
    "ob_get_database_dictionary",
    "ob_capture_metadata_snapshot",
    "ob_compare_metadata_snapshots",
    "ob_find_sql_usages",
    "ob_analyze_change_sql_impact",
    "ob_analyze_metadata_impact",
    "ob_generate_metadata_change_report",
    "ob_validate_sql_snippet",
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
    objectListOk: isOracle ? oracleObjects.length > 0 : objectListResult.warnings?.length > 0,
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
    schemaMapOk:
      schemaMapResult.mode === compatibility &&
      schemaMapResult.tableCount >= 1 &&
      schemaMapResult.schemas.some((schema) => schema.schema === smokeSchema),
    preparedQueryOk:
      preparedQueryResult.executed === false &&
      preparedQueryResult.mode === compatibility &&
      preparedQueryResult.candidateCount >= 1 &&
      preparedQueryResult.candidates.some((candidate) => candidate.table === smokeTable),
    builtSelectOk:
      builtSelectResult.executed === false &&
      builtSelectResult.policy?.allowed === true &&
      builtSelectResult.pagination?.pageSize === 2,
    sqlLintOk:
      sqlLintResult.executed === false &&
      sqlLintResult.explainRun === false &&
      Array.isArray(sqlLintResult.findings),
    querySessionOk:
      querySessionStartResult.executed === false &&
      querySessionReadResult.sessionId === querySessionStartResult.sessionId &&
      querySessionReadResult.paramCount === 0 &&
      querySessionCloseResult.closed === true,
    erHtmlOk:
      erHtmlResult.contentType === "text/html" &&
      erHtmlResult.format === "html-static" &&
      typeof erHtmlResult.html === "string" &&
      erHtmlResult.html.includes("<!doctype html>"),
    erPlanOk:
      erPlanResult.format === "html-interactive" &&
      erPlanResult.chunkCount >= 1 &&
      erPlanResult.chunks.every((chunk) => chunk.command.includes("ob-mcp export-er")),
    databaseDictionaryOk:
      databaseDictionaryResult.format === "json" &&
      databaseDictionaryResult.dictionary?.tables?.some((table) => table.schema === smokeSchema && table.table === smokeTable),
    metadataSnapshotOk:
      metadataSnapshotResult.snapshotVersion === "1.1" &&
      metadataSnapshotResult.executed === false &&
      metadataSnapshotResult.compatibility === compatibility &&
      metadataSnapshotResult.tables.some((table) => table.schema === smokeSchema && table.table === smokeTable) &&
      (!isOracle || metadataSnapshotResult.oracleObjects.length > 0),
    metadataDiffOk:
      metadataDiffResult.executed === false &&
      metadataDiffResult.summary.totalChanges > 0 &&
      metadataDiffResult.changes.columns.length > 0 &&
      (!isOracle || metadataDiffResult.changes.oracleObjects.length > 0),
    sqlUsageIndexOk:
      sqlUsageResult.executed === false &&
      sqlUsageResult.matchCount > 0 &&
      sqlUsageResult.results.some((result) => result.file === "mapper/SmokeMapper.xml"),
    changeSqlImpactOk:
      changeSqlImpactResult.executed === false &&
      changeSqlImpactResult.summary.impactedSql > 0,
    metadataImpactOk:
      metadataImpactResult.executed === false &&
      metadataImpactResult.sqlImpact?.summary?.impactedSql > 0,
    metadataReportOk:
      metadataReportResult.executed === false &&
      (isOracle
        ? metadataReportResult.contentType === "text/html" && metadataReportResult.html.includes("MCP Smoke Metadata Change Report")
        : metadataReportResult.contentType === "text/markdown" && metadataReportResult.markdown.includes("MCP Smoke Metadata Change Report")),
    sqlSnippetValidationOk:
      sqlSnippetValidationResult.executed === false &&
      Array.isArray(sqlSnippetValidationResult.findings) &&
      sqlSnippetValidationResult.metadata?.tables?.some((table) => table.schema === smokeSchema && table.table === smokeTable),
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
    !output.schemaMapOk ||
    !output.preparedQueryOk ||
    !output.builtSelectOk ||
    !output.sqlLintOk ||
    !output.querySessionOk ||
    !output.erHtmlOk ||
    !output.erPlanOk ||
    !output.databaseDictionaryOk ||
    !output.metadataSnapshotOk ||
    !output.metadataDiffOk ||
    !output.sqlUsageIndexOk ||
    !output.changeSqlImpactOk ||
    !output.metadataImpactOk ||
    !output.metadataReportOk ||
    !output.sqlSnippetValidationOk ||
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

function changedSmokeSnapshot(snapshot) {
  const changed = JSON.parse(JSON.stringify(snapshot));
  changed.capturedAt = new Date(Date.now() + 1_000).toISOString();
  changed.fingerprint = `${snapshot.fingerprint}:smoke-after`;

  const table = changed.tables[0];
  if (table) {
    if (Array.isArray(table.columns) && table.columns.length > 1) {
      table.columns = table.columns.slice(0, table.columns.length - 1);
    } else {
      table.comment = `${table.comment ?? ""} smoke change`.trim();
    }
    table.fingerprint = `${table.fingerprint}:smoke-after`;
  }

  const object = changed.oracleObjects?.[0];
  if (object) {
    object.status = "INVALID";
    object.fingerprint = `${object.fingerprint}:smoke-after`;
  }

  return changed;
}

function smokeSqlUsageIndex() {
  return {
    indexVersion: "1.1",
    generatedAt: new Date().toISOString(),
    root: process.cwd(),
    scannedFiles: 1,
    skippedFiles: 0,
    snippetCount: 1,
    entries: [{
      file: "mapper/SmokeMapper.xml",
      line: 12,
      sql: `SELECT ${smokeIdColumn}, ${smokeMaskedColumn} FROM ${qualifiedTable} WHERE ${smokeIdColumn} = #{id}`,
      statementType: "select",
      tables: [qualifiedTable],
      columns: [smokeIdColumn, smokeMaskedColumn],
      dynamicSql: { detected: false, sources: [] },
      risks: ["missing_pagination"],
      dialectHints: [isOracle ? "oracle" : "mysql"]
    }],
    warnings: [],
    limits: {
      maxFiles: 1,
      maxBytes: 4096,
      extensions: [".xml"],
      ignore: []
    }
  };
}
