import type { ObConfig } from "../config.js";
import type { SqlParam } from "../db.js";
import { effectiveRowLimit, shouldMaskColumnValue } from "../query/output.js";
import { explainGeneratedQuery } from "./sql-policy-explain.js";
import type { BuildSelectFilter, BuildSelectOrderBy } from "./schemas.js";

export function buildStructuredSelect(
  config: ObConfig,
  schema: string | undefined,
  table: string,
  columnRows: unknown[],
  input: {
    columns?: string[];
    filters: BuildSelectFilter[];
    orderBy: BuildSelectOrderBy[];
    pageSize?: number;
    page?: number;
  }
) {
  const warnings: string[] = [];
  const columns = buildSelectColumnInfos(config, schema, table, columnRows);
  if (columns.length === 0) {
    throw new Error("No visible columns are available for this table under the active MCP policy.");
  }
  const selectedColumns = selectBuildColumns(config, columns, input.columns, warnings);
  const where = buildSelectWhereClause(config, columns, input.filters);
  const orderClause = buildSelectOrderClause(config, columns, input.orderBy, warnings);
  const safePageSize = effectiveRowLimit(input.pageSize ?? Math.min(config.maxRows, 50), config);
  const safePage = input.page ?? 1;
  const offset = (safePage - 1) * safePageSize;
  const tableRef = sqlQualifiedTable(config.compatibility, schema, table);
  const selectList = selectedColumns.map((column) => sqlQuoteIdentifier(config.compatibility, column.name)).join(", ");
  const baseSql = [
    `SELECT ${selectList}`,
    `FROM ${tableRef}`,
    where.clause ? `WHERE ${where.clause}` : undefined,
    orderClause
  ].filter((part): part is string => Boolean(part)).join(" ");
  const paginationSql = config.compatibility === "oracle"
    ? `${baseSql} OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`
    : `${baseSql} LIMIT ? OFFSET ?`;
  const paginationParams: SqlParam[] = config.compatibility === "oracle"
    ? [offset, safePageSize]
    : [safePageSize, offset];
  const params = [...where.params, ...paginationParams];
  const paramHints = [
    ...where.paramHints,
    ...(config.compatibility === "oracle"
      ? [
          { name: "offset", type: "number", value: offset, description: "Rows to skip." },
          { name: "pageSize", type: "number", value: safePageSize, description: "Rows to return, capped by OB_MAX_ROWS." }
        ]
      : [
          { name: "pageSize", type: "number", value: safePageSize, description: "Rows to return, capped by OB_MAX_ROWS." },
          { name: "offset", type: "number", value: offset, description: "Rows to skip." }
        ])
  ];
  const policy = explainGeneratedQuery(paginationSql, params.length, config);

  return {
    sql: paginationSql,
    params,
    paramHints,
    columns: selectedColumns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      masked: column.masked
    })),
    filters: input.filters,
    orderBy: input.orderBy,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      offset,
      dialect: config.compatibility
    },
    policy,
    warnings
  };
}

export function buildSelectColumnInfos(
  config: ObConfig,
  schema: string | undefined,
  table: string,
  rows: unknown[]
): Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }> {
  return rows
    .map((row) => profileColumnMetadata(row, config.compatibility))
    .filter((column): column is { name: string; dataType?: string; nullable?: boolean; comment?: string } => Boolean(column))
    .map((column) => ({
      name: column.name,
      type: column.dataType,
      nullable: column.nullable,
      comment: column.comment,
      masked: shouldMaskColumnValue(column.name, config, schema, table)
    }));
}

export function getBuildColumn(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  column: string
) {
  const normalized = normalizeTableName(config.compatibility, column);
  const match = available.find((item) => normalizeTableName(config.compatibility, item.name) === normalized);
  if (!match) {
    throw new Error(`Column "${column}" is not visible on this table under the active MCP policy.`);
  }
  return match;
}

export function sqlQuoteIdentifier(mode: ObConfig["compatibility"], value: string): string {
  if (mode === "oracle") {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return `\`${value.replace(/`/g, "``")}\``;
}

export function selectBuildColumns(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  requested: string[] | undefined,
  warnings: string[]
) {
  if (requested && requested.length > 0) {
    return requested.map((column) => getBuildColumn(config, available, column));
  }
  const unmasked = available.filter((column) => !column.masked).slice(0, 12);
  const selected = unmasked.length > 0 ? unmasked : available.slice(0, 12);
  if (available.length > selected.length) {
    warnings.push(`Only the first ${selected.length} visible columns are included by default. Pass columns for a specific projection.`);
  }
  if (unmasked.length === 0 && selected.some((column) => column.masked)) {
    warnings.push("Default projection contains masked columns because no unmasked visible columns were available.");
  }
  return selected;
}

function buildSelectWhereClause(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  filters: BuildSelectFilter[]
) {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const paramHints: Array<{ name: string; column: string; operator: string; value?: SqlParam; description: string }> = [];
  for (const filter of filters) {
    const column = getBuildColumn(config, available, filter.column);
    const columnRef = sqlQuoteIdentifier(config.compatibility, column.name);
    const operator = filter.operator;
    if (operator === "is_null" || operator === "is_not_null") {
      clauses.push(`${columnRef} IS ${operator === "is_null" ? "" : "NOT "}NULL`);
      continue;
    }
    if (operator === "in") {
      const values = assertSqlParamArray(filter.value, filter.column, operator);
      if (values.length === 0 || values.length > 100) {
        throw new Error("IN filters require between 1 and 100 values.");
      }
      clauses.push(`${columnRef} IN (${values.map(() => "?").join(", ")})`);
      for (const value of values) {
        params.push(value);
        paramHints.push({ name: filter.column, column: column.name, operator, value, description: "IN-list value." });
      }
      continue;
    }
    if (operator === "between") {
      const values = assertSqlParamArray(filter.value, filter.column, operator);
      if (values.length !== 2) {
        throw new Error("BETWEEN filters require exactly two values.");
      }
      clauses.push(`${columnRef} BETWEEN ? AND ?`);
      for (const value of values) {
        params.push(value);
        paramHints.push({ name: filter.column, column: column.name, operator, value, description: "BETWEEN boundary value." });
      }
      continue;
    }
    const value = assertSingleSqlParam(filter.value, filter.column, operator);
    clauses.push(`${columnRef} ${sqlOperator(operator)} ?`);
    params.push(value);
    paramHints.push({ name: filter.column, column: column.name, operator, value, description: "Filter value." });
  }
  return {
    clause: clauses.join(" AND "),
    params,
    paramHints
  };
}

function buildSelectOrderClause(
  config: ObConfig,
  available: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; masked: boolean }>,
  orderBy: BuildSelectOrderBy[],
  warnings: string[]
): string | undefined {
  if (orderBy.length === 0) {
    warnings.push("No ORDER BY was provided. Page order may be unstable.");
    return undefined;
  }
  const items = orderBy.map((item) => {
    const column = getBuildColumn(config, available, item.column);
    const direction = item.direction ? ` ${item.direction.toUpperCase()}` : "";
    const nulls = item.nulls ? ` NULLS ${item.nulls.toUpperCase()}` : "";
    return `${sqlQuoteIdentifier(config.compatibility, column.name)}${direction}${nulls}`;
  });
  return `ORDER BY ${items.join(", ")}`;
}

function assertSingleSqlParam(value: unknown, column: string, operator: string): SqlParam {
  if (Array.isArray(value)) {
    throw new Error(`Filter "${column}" with operator "${operator}" expects a single value.`);
  }
  if (value === undefined) {
    throw new Error(`Filter "${column}" with operator "${operator}" requires a value.`);
  }
  return value as SqlParam;
}

function assertSqlParamArray(value: unknown, column: string, operator: string): SqlParam[] {
  if (!Array.isArray(value)) {
    throw new Error(`Filter "${column}" with operator "${operator}" expects an array value.`);
  }
  return value as SqlParam[];
}

function sqlOperator(operator: BuildSelectFilter["operator"]): string {
  switch (operator) {
    case "eq":
      return "=";
    case "ne":
      return "<>";
    case "gt":
      return ">";
    case "gte":
      return ">=";
    case "lt":
      return "<";
    case "lte":
      return "<=";
    case "like":
      return "LIKE";
    default:
      throw new Error(`Unsupported filter operator "${operator}".`);
  }
}

function sqlQualifiedTable(mode: ObConfig["compatibility"], schema: string | undefined, table: string): string {
  return schema
    ? `${sqlQuoteIdentifier(mode, mode === "oracle" ? schema.trim().toUpperCase() : schema.trim())}.${sqlQuoteIdentifier(mode, table)}`
    : sqlQuoteIdentifier(mode, table);
}

function profileColumnMetadata(
  row: unknown,
  mode: ObConfig["compatibility"]
): { name: string; dataType?: string; nullable?: boolean; comment?: string } | undefined {
  const record = row as Record<string, unknown>;
  const name = stringRecordValue(record, "column_name", "COLUMN_NAME");
  if (!name) {
    return undefined;
  }
  const nullableText = stringRecordValue(record, "is_nullable", "IS_NULLABLE", "nullable", "NULLABLE");
  return {
    name,
    dataType: columnTypeLabel(mode, record),
    nullable: nullableText ? !["NO", "N"].includes(nullableText.toUpperCase()) : undefined,
    comment: stringRecordValue(record, "column_comment", "COLUMN_COMMENT", "comments", "COMMENTS")
  };
}

function columnTypeLabel(mode: ObConfig["compatibility"], record: Record<string, unknown>): string | undefined {
  const mysqlType = stringRecordValue(record, "column_type", "COLUMN_TYPE");
  if (mysqlType) {
    return mysqlType;
  }
  const dataType = stringRecordValue(record, "data_type", "DATA_TYPE");
  const length = numberRecordValue(record, "data_length", "DATA_LENGTH");
  if (
    mode === "oracle" &&
    dataType &&
    length &&
    ["CHAR", "NCHAR", "VARCHAR2", "NVARCHAR2", "RAW"].includes(dataType)
  ) {
    return `${dataType}(${length})`;
  }
  return dataType;
}

function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

function numberRecordValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = keys
    .map((key) => record[key])
    .find((item) => typeof item === "number" || typeof item === "string");
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
