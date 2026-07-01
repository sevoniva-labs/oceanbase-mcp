import type { CompatibilityMode } from "./config.js";
import type { TableRelationship } from "./db.js";

export type QueryTemplateScenario = "by_primary_key" | "pagination" | "time_range" | "aggregation" | "join";

export interface QueryTemplateParameter {
  name: string;
  placeholder: string;
  type?: string;
  description: string;
}

export interface GeneratedQueryTemplate {
  scenario: QueryTemplateScenario;
  title: string;
  sql: string;
  parameters: QueryTemplateParameter[];
  notes: string[];
}

export interface QueryGenerationInput {
  mode: CompatibilityMode;
  schema?: string;
  table: string;
  columns: unknown[];
  constraints: unknown[];
  relationships: TableRelationship[];
  scenarios?: QueryTemplateScenario[];
  maxColumns: number;
  rowLimit: number;
}

export interface QueryGenerationResult {
  templates: GeneratedQueryTemplate[];
  warnings: string[];
}

interface ColumnInfo {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey: boolean;
}

const DEFAULT_SCENARIOS: QueryTemplateScenario[] = ["by_primary_key", "pagination", "time_range", "aggregation", "join"];
const TIME_NAME_PATTERN = /(created|updated|modified|time|date|timestamp|gmt_)/i;
const GROUP_NAME_PATTERN = /^(status|state|type|category|kind|level|tenant|region)$/i;

export function generateQueryTemplates(input: QueryGenerationInput): QueryGenerationResult {
  const columns = columnInfos(input.mode, input.columns, input.constraints);
  const selectedColumns = columns.slice(0, input.maxColumns);
  const scenarios = input.scenarios && input.scenarios.length > 0 ? input.scenarios : DEFAULT_SCENARIOS;
  const templates: GeneratedQueryTemplate[] = [];
  const warnings: string[] = [];

  if (columns.length === 0) {
    return {
      templates,
      warnings: ["No visible columns are available after policy filtering."]
    };
  }

  if (columns.length > selectedColumns.length) {
    warnings.push(`Only the first ${selectedColumns.length} visible columns are included in generated SELECT lists.`);
  }

  for (const scenario of scenarios) {
    const template = buildScenarioTemplate(input, columns, selectedColumns, scenario);
    if (template) {
      templates.push(template);
    } else {
      warnings.push(`Scenario "${scenario}" was skipped because required metadata was not available.`);
    }
  }

  return { templates, warnings };
}

function buildScenarioTemplate(
  input: QueryGenerationInput,
  columns: ColumnInfo[],
  selectedColumns: ColumnInfo[],
  scenario: QueryTemplateScenario
): GeneratedQueryTemplate | undefined {
  const primaryKey = columns.find((column) => column.primaryKey) ?? columns[0];
  const tableRef = qualifiedTable(input.mode, input.schema, input.table);
  const selectList = selectedColumns.map((column) => quoteIdentifier(input.mode, column.name)).join(", ");

  if (scenario === "by_primary_key") {
    if (!primaryKey) {
      return undefined;
    }
    const pk = quoteIdentifier(input.mode, primaryKey.name);
    return {
      scenario,
      title: "Lookup row by primary key",
      sql: input.mode === "oracle"
        ? `SELECT ${selectList} FROM ${tableRef} WHERE ${pk} = ? AND ROWNUM <= 1`
        : `SELECT ${selectList} FROM ${tableRef} WHERE ${pk} = ? LIMIT 1`,
      parameters: [{
        name: primaryKey.name,
        placeholder: "?",
        type: primaryKey.type,
        description: "Primary-key value to look up."
      }],
      notes: [primaryKey.primaryKey ? "Uses detected primary-key metadata." : "No primary key was found; the first visible column is used as a placeholder."]
    };
  }

  if (scenario === "pagination") {
    const orderColumn = primaryKey ?? selectedColumns[0];
    if (!orderColumn) {
      return undefined;
    }
    const orderBy = quoteIdentifier(input.mode, orderColumn.name);
    return {
      scenario,
      title: "Page through rows with a stable order",
      sql: input.mode === "oracle"
        ? `SELECT ${selectList} FROM ${tableRef} ORDER BY ${orderBy} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
        : `SELECT ${selectList} FROM ${tableRef} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      parameters: input.mode === "oracle"
        ? [
            { name: "offset", placeholder: "?", type: "number", description: "Number of rows to skip." },
            { name: "limit", placeholder: "?", type: "number", description: `Rows to return, capped by OB_MAX_ROWS (${input.rowLimit}).` }
          ]
        : [
            { name: "limit", placeholder: "?", type: "number", description: `Rows to return, capped by OB_MAX_ROWS (${input.rowLimit}).` },
            { name: "offset", placeholder: "?", type: "number", description: "Number of rows to skip." }
          ],
      notes: ["Use a deterministic ORDER BY column for repeatable pages."]
    };
  }

  if (scenario === "time_range") {
    const timeColumn = columns.find((column) => isTimeColumn(column));
    if (!timeColumn) {
      return undefined;
    }
    const timeRef = quoteIdentifier(input.mode, timeColumn.name);
    return {
      scenario,
      title: "Filter rows by time range",
      sql: input.mode === "oracle"
        ? `SELECT ${selectList} FROM ${tableRef} WHERE ${timeRef} >= ? AND ${timeRef} < ? ORDER BY ${timeRef} FETCH FIRST ${input.rowLimit} ROWS ONLY`
        : `SELECT ${selectList} FROM ${tableRef} WHERE ${timeRef} >= ? AND ${timeRef} < ? ORDER BY ${timeRef} LIMIT ?`,
      parameters: input.mode === "oracle"
        ? [
            { name: "start_time", placeholder: "?", type: timeColumn.type, description: "Inclusive lower bound." },
            { name: "end_time", placeholder: "?", type: timeColumn.type, description: "Exclusive upper bound." }
          ]
        : [
            { name: "start_time", placeholder: "?", type: timeColumn.type, description: "Inclusive lower bound." },
            { name: "end_time", placeholder: "?", type: timeColumn.type, description: "Exclusive upper bound." },
            { name: "limit", placeholder: "?", type: "number", description: `Rows to return, capped by OB_MAX_ROWS (${input.rowLimit}).` }
          ],
      notes: ["Uses a date/time-like column inferred from metadata."]
    };
  }

  if (scenario === "aggregation") {
    const groupColumn = columns.find((column) => GROUP_NAME_PATTERN.test(column.name)) ?? columns.find((column) => isTextColumn(column));
    const countColumn = primaryKey ?? columns[0];
    if (!countColumn) {
      return undefined;
    }
    const countExpr = `COUNT(${quoteIdentifier(input.mode, countColumn.name)})`;
    if (!groupColumn) {
      return {
        scenario,
        title: "Count rows",
        sql: `SELECT ${countExpr} AS row_count FROM ${tableRef}`,
        parameters: [],
        notes: ["No categorical column was found for GROUP BY."]
      };
    }
    const groupRef = quoteIdentifier(input.mode, groupColumn.name);
    return {
      scenario,
      title: "Aggregate rows by a categorical column",
      sql: input.mode === "oracle"
        ? `SELECT ${groupRef}, ${countExpr} AS row_count FROM ${tableRef} GROUP BY ${groupRef} ORDER BY row_count DESC FETCH FIRST ${input.rowLimit} ROWS ONLY`
        : `SELECT ${groupRef}, ${countExpr} AS row_count FROM ${tableRef} GROUP BY ${groupRef} ORDER BY row_count DESC LIMIT ?`,
      parameters: input.mode === "oracle"
        ? []
        : [{ name: "limit", placeholder: "?", type: "number", description: `Groups to return, capped by OB_MAX_ROWS (${input.rowLimit}).` }],
      notes: ["Review the grouping column before using this in application code."]
    };
  }

  if (scenario === "join") {
    const relation = input.relationships.find((item) => item.sourceColumns.length > 0 && item.targetColumns.length > 0);
    if (!relation) {
      return undefined;
    }
    const sourceRef = qualifiedTable(input.mode, relation.sourceSchema ?? input.schema, relation.sourceTable);
    const targetRef = qualifiedTable(input.mode, relation.targetSchema, relation.targetTable);
    const sourceColumn = quoteIdentifier(input.mode, relation.sourceColumns[0]);
    const targetColumn = quoteIdentifier(input.mode, relation.targetColumns[0]);
    const sourceAlias = input.mode === "oracle" ? "s" : "`s`";
    const targetAlias = input.mode === "oracle" ? "t" : "`t`";
    const sourceSelect = selectedColumns.slice(0, Math.min(6, selectedColumns.length)).map((column) =>
      `${sourceAlias}.${quoteIdentifier(input.mode, column.name)}`
    );
    const targetSelect = `${targetAlias}.${targetColumn} AS ${quoteIdentifier(input.mode, `target_${relation.targetColumns[0]}`)}`;
    return {
      scenario,
      title: "Join related tables",
      sql: input.mode === "oracle"
        ? `SELECT ${[...sourceSelect, targetSelect].join(", ")} FROM ${sourceRef} s JOIN ${targetRef} t ON s.${sourceColumn} = t.${targetColumn} FETCH FIRST ${input.rowLimit} ROWS ONLY`
        : `SELECT ${[...sourceSelect, targetSelect].join(", ")} FROM ${sourceRef} AS ${sourceAlias} JOIN ${targetRef} AS ${targetAlias} ON ${sourceAlias}.${sourceColumn} = ${targetAlias}.${targetColumn} LIMIT ?`,
      parameters: input.mode === "oracle"
        ? []
        : [{ name: "limit", placeholder: "?", type: "number", description: `Rows to return, capped by OB_MAX_ROWS (${input.rowLimit}).` }],
      notes: [
        `Relationship source: ${relation.relationType}; confidence ${relation.confidence}.`,
        "Review join cardinality and selected columns before using this in application code."
      ]
    };
  }

  return undefined;
}

function columnInfos(mode: CompatibilityMode, rows: unknown[], constraints: unknown[]): ColumnInfo[] {
  const primaryKeys = new Set(primaryKeyColumns(mode, constraints));
  const output: ColumnInfo[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const name = stringValue(record.column_name, record.COLUMN_NAME);
    if (!name) {
      continue;
    }
    const info: ColumnInfo = {
      name,
      primaryKey: primaryKeys.has(normalizeName(mode, name))
    };
    const type = columnType(mode, record);
    if (type) {
      info.type = type;
    }
    const nullable = stringValue(record.is_nullable, record.IS_NULLABLE, record.nullable, record.NULLABLE);
    if (nullable) {
      info.nullable = !["NO", "N"].includes(nullable.toUpperCase());
    }
    output.push(info);
  }
  return output;
}

function primaryKeyColumns(mode: CompatibilityMode, constraints: unknown[]): string[] {
  return constraints
    .filter((row) => {
      const type = stringValue((row as Record<string, unknown>).constraint_type, (row as Record<string, unknown>).CONSTRAINT_TYPE);
      return type === "PRIMARY KEY" || type === "P";
    })
    .map((row) => stringValue((row as Record<string, unknown>).column_name, (row as Record<string, unknown>).COLUMN_NAME))
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeName(mode, value));
}

function columnType(mode: CompatibilityMode, record: Record<string, unknown>): string | undefined {
  const mysqlType = stringValue(record.column_type, record.COLUMN_TYPE);
  if (mysqlType) {
    return mysqlType;
  }
  const dataType = stringValue(record.data_type, record.DATA_TYPE);
  const length = numberValue(record.data_length, record.DATA_LENGTH);
  if (mode === "oracle" && dataType && length && ["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType)) {
    return `${dataType}(${length})`;
  }
  return dataType;
}

function isTimeColumn(column: ColumnInfo): boolean {
  const type = column.type ?? "";
  return TIME_NAME_PATTERN.test(column.name) || /\b(date|time|timestamp|datetime)\b/i.test(type);
}

function isTextColumn(column: ColumnInfo): boolean {
  return /\b(char|text|clob|varchar|string)\b/i.test(column.type ?? "");
}

function qualifiedTable(mode: CompatibilityMode, schema: string | undefined, table: string): string {
  return schema ? `${quoteIdentifier(mode, schema)}.${quoteIdentifier(mode, table)}` : quoteIdentifier(mode, table);
}

function quoteIdentifier(mode: CompatibilityMode, value: string): string {
  if (mode === "oracle") {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

function normalizeName(mode: CompatibilityMode, value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function stringValue(...values: unknown[]): string | undefined {
  const value = values.find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  const value = values.find((item) => typeof item === "number" || typeof item === "string");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
