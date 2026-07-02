import type { ObConfig } from "../config.js";
import { formatPreviewValue, maskQueryRows, renderMarkdownPreview, shouldMaskColumnValue } from "./output.js";

export interface ResultSummaryColumn {
  name: string;
  type?: string;
  table?: string;
  schema?: string;
  masked?: boolean;
}

export function summarizeQueryResultRows(
  rows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[],
  config: ObConfig,
  maxTopValues: number
) {
  const columnNames = resultSummaryColumnNames(rows, columns);
  const columnMetadata = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const summaries = columnNames.map((name) =>
    summarizeResultColumn(name, rows, columnMetadata.get(name.toLowerCase()), config, maxTopValues)
  );
  const maskedColumns = summaries.filter((column) => column.masked).map((column) => column.name);
  const timeColumns = summaries
    .filter((column) => column.timeRange)
    .map((column) => column.name);
  const dimensionColumns = summaries
    .filter((column) => column.distinct.count > 0 && column.distinct.count <= Math.max(20, Math.ceil(rows.length / 2)))
    .map((column) => column.name);
  return {
    empty: rows.length === 0,
    columns: summaries,
    maskedColumns,
    timeColumns,
    dimensionColumns,
    nextSteps: resultSummaryNextSteps(rows.length, maskedColumns, timeColumns, dimensionColumns)
  };
}

export function compareQueryResultRows(
  leftRows: Array<Record<string, unknown>>,
  rightRows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[],
  keyColumns: string[],
  compareColumns: string[] | undefined,
  config: ObConfig,
  maxDifferences: number
) {
  const allColumns = resultSummaryColumnNames([...leftRows, ...rightRows], columns);
  const selectedColumns = compareColumns && compareColumns.length > 0
    ? uniqueStrings(compareColumns)
    : allColumns;
  const metadata = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  const columnPresence = allColumns.map((name) => ({
    name,
    inLeft: leftRows.some((row) => Object.prototype.hasOwnProperty.call(row, name)),
    inRight: rightRows.some((row) => Object.prototype.hasOwnProperty.call(row, name))
  }));
  const valueDifferences = selectedColumns
    .filter((name) => columnPresence.some((column) => column.name === name && column.inLeft && column.inRight))
    .map((name) => compareResultColumn(name, leftRows, rightRows, metadata.get(name.toLowerCase()), config, maxDifferences))
    .filter((item) => item.changed);
  const keyComparison = keyColumns.length > 0
    ? compareResultKeys(leftRows, rightRows, keyColumns, metadata, config)
    : undefined;
  return {
    rowCounts: {
      left: leftRows.length,
      right: rightRows.length,
      delta: rightRows.length - leftRows.length
    },
    columnPresence,
    keyComparison,
    valueDifferences,
    warnings: compareResultWarnings(columns, keyColumns, compareColumns)
  };
}

export function buildResultPreview(
  rows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[],
  format: "markdown" | "csv",
  maxRows: number,
  config: ObConfig
) {
  const columnInfos = resultPreviewColumns(rows, columns, config);
  const columnNames = columnInfos.map((column) => column.name);
  const visibleRows = rows.slice(0, maxRows);
  const maskedRows = maskQueryRows(visibleRows, columnInfos);
  const text = format === "csv"
    ? renderCsvPreview(maskedRows, columnNames)
    : renderMarkdownPreview(maskedRows, columnNames);
  const warnings: string[] = [];
  const maskedColumns = columnInfos.filter((column) => column.masked).map((column) => column.name);
  if (maskedColumns.length > 0) {
    warnings.push(`Masked preview columns: ${maskedColumns.join(", ")}.`);
  }
  if (rows.length > visibleRows.length) {
    warnings.push(`Preview was limited to ${visibleRows.length} of ${rows.length} rows.`);
  }
  if (columnNames.length > 50 && format === "markdown") {
    warnings.push("Markdown preview displays up to 12 columns; use CSV for wider previews.");
  }
  return {
    rowCount: rows.length,
    returnedRows: visibleRows.length,
    columns: columnInfos,
    text,
    warnings
  };
}

function resultSummaryColumnNames(
  rows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[]
): string[] {
  const names = columns.map((column) => column.name);
  for (const row of rows) {
    names.push(...Object.keys(row));
  }
  return uniqueStrings(names.filter(Boolean)).slice(0, 200);
}

function summarizeResultColumn(
  name: string,
  rows: Array<Record<string, unknown>>,
  metadata: ResultSummaryColumn | undefined,
  config: ObConfig,
  maxTopValues: number
) {
  const values = rows.map((row) => row[name]);
  const nullCount = values.filter((value) => value == null).length;
  const nonNullValues = values.filter((value) => value != null);
  const masked = Boolean(metadata?.masked) || shouldMaskColumnValue(name, config, metadata?.schema, metadata?.table);
  const counts = valueCounts(nonNullValues, maxTopValues);
  const numericRange = masked ? undefined : numericSummary(nonNullValues);
  const timeRange = masked ? undefined : timeSummary(name, metadata?.type, nonNullValues);
  return {
    name,
    type: metadata?.type,
    table: metadata?.table,
    schema: metadata?.schema,
    masked,
    nulls: {
      count: nullCount,
      ratio: rows.length === 0 ? 0 : nullCount / rows.length
    },
    distinct: {
      count: new Set(nonNullValues.map(summaryValueKey)).size,
      exact: rows.length <= 1_000
    },
    topValues: masked
      ? []
      : counts.map((item) => ({
          value: item.value,
          count: item.count,
          ratio: rows.length === 0 ? 0 : item.count / rows.length
        })),
    numericRange,
    timeRange,
    warnings: masked ? ["Values are hidden because the column is marked or detected as sensitive."] : []
  };
}

function compareResultColumn(
  name: string,
  leftRows: Array<Record<string, unknown>>,
  rightRows: Array<Record<string, unknown>>,
  metadata: ResultSummaryColumn | undefined,
  config: ObConfig,
  maxDifferences: number
) {
  const masked = Boolean(metadata?.masked) || shouldMaskColumnValue(name, config, metadata?.schema, metadata?.table);
  const leftValues = leftRows.map((row) => row[name]).filter((value) => value != null);
  const rightValues = rightRows.map((row) => row[name]).filter((value) => value != null);
  const leftCounts = new Map(valueCounts(leftValues, maxDifferences * 2).map((item) => [summaryValueKey(item.value), item]));
  const rightCounts = new Map(valueCounts(rightValues, maxDifferences * 2).map((item) => [summaryValueKey(item.value), item]));
  const keys = uniqueStrings([...leftCounts.keys(), ...rightCounts.keys()]);
  const valueDeltas = keys
    .map((key) => {
      const left = leftCounts.get(key);
      const right = rightCounts.get(key);
      return {
        value: masked ? "[masked]" : left?.value ?? right?.value,
        leftCount: left?.count ?? 0,
        rightCount: right?.count ?? 0,
        delta: (right?.count ?? 0) - (left?.count ?? 0)
      };
    })
    .filter((item) => item.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, maxDifferences);
  const leftNumeric = masked ? undefined : numericSummary(leftValues);
  const rightNumeric = masked ? undefined : numericSummary(rightValues);
  return {
    column: name,
    masked,
    changed: valueDeltas.length > 0 || JSON.stringify(leftNumeric) !== JSON.stringify(rightNumeric),
    distinct: {
      left: new Set(leftValues.map(summaryValueKey)).size,
      right: new Set(rightValues.map(summaryValueKey)).size
    },
    valueDeltas,
    numericRange: {
      left: leftNumeric,
      right: rightNumeric
    }
  };
}

function compareResultKeys(
  leftRows: Array<Record<string, unknown>>,
  rightRows: Array<Record<string, unknown>>,
  keyColumns: string[],
  metadata: Map<string, ResultSummaryColumn>,
  config: ObConfig
) {
  const keyMasked = keyColumns.some((column) => {
    const columnMetadata = metadata.get(column.toLowerCase());
    return Boolean(columnMetadata?.masked) || shouldMaskColumnValue(column, config, columnMetadata?.schema, columnMetadata?.table);
  });
  const leftKeys = new Set(leftRows.map((row) => resultRowKey(row, keyColumns)));
  const rightKeys = new Set(rightRows.map((row) => resultRowKey(row, keyColumns)));
  const onlyLeft = [...leftKeys].filter((key) => !rightKeys.has(key));
  const onlyRight = [...rightKeys].filter((key) => !leftKeys.has(key));
  return {
    keyColumns,
    keyValuesHidden: keyMasked,
    onlyInLeftCount: onlyLeft.length,
    onlyInRightCount: onlyRight.length,
    sampleOnlyInLeft: keyMasked ? [] : onlyLeft.slice(0, 10),
    sampleOnlyInRight: keyMasked ? [] : onlyRight.slice(0, 10)
  };
}

function compareResultWarnings(
  columns: ResultSummaryColumn[],
  keyColumns: string[],
  compareColumns: string[] | undefined
): string[] {
  const warnings: string[] = [];
  if (keyColumns.length === 0) {
    warnings.push("No keyColumns were supplied; row-level comparison is limited to row counts and column value distributions.");
  }
  if (compareColumns && compareColumns.length > 0) {
    warnings.push("Only requested compareColumns were compared for value differences.");
  }
  if (columns.some((column) => column.masked)) {
    warnings.push("Masked columns are compared by counts only; raw values are not returned.");
  }
  return warnings;
}

function resultPreviewColumns(
  rows: Array<Record<string, unknown>>,
  columns: ResultSummaryColumn[],
  config: ObConfig
): Array<{ name: string; table?: string; schema?: string; masked: boolean }> {
  const metadata = new Map(columns.map((column) => [column.name.toLowerCase(), column]));
  return resultSummaryColumnNames(rows, columns).map((name) => {
    const column = metadata.get(name.toLowerCase());
    return {
      name,
      table: column?.table,
      schema: column?.schema,
      masked: Boolean(column?.masked) || shouldMaskColumnValue(name, config, column?.schema, column?.table)
    };
  });
}

function valueCounts(values: unknown[], limit: number): Array<{ value: unknown; count: number }> {
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const value of values) {
    const key = summaryValueKey(value);
    const current = counts.get(key);
    if (current) {
      current.count += 1;
    } else {
      counts.set(key, { value: summaryValue(value), count: 1 });
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)))
    .slice(0, limit);
}

function numericSummary(values: unknown[]) {
  const numbers = values
    .map((value) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN)
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return undefined;
  }
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers)
  };
}

function timeSummary(name: string, type: string | undefined, values: unknown[]) {
  const looksTemporal = /(time|date|created|updated|modified|gmt_)/i.test(`${name} ${type ?? ""}`);
  if (!looksTemporal) {
    return undefined;
  }
  const timestamps = values
    .map((value) => {
      if (value instanceof Date) {
        return value.getTime();
      }
      if (typeof value === "string" || typeof value === "number") {
        const time = Date.parse(String(value));
        return Number.isFinite(time) ? time : NaN;
      }
      return NaN;
    })
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return undefined;
  }
  return {
    min: new Date(Math.min(...timestamps)).toISOString(),
    max: new Date(Math.max(...timestamps)).toISOString()
  };
}

function resultRowKey(row: Record<string, unknown>, keyColumns: string[]): string {
  return keyColumns.map((column) => String(summaryValue(row[column]))).join("|");
}

function summaryValue(value: unknown): unknown {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return "[complex]";
}

function summaryValueKey(value: unknown): string {
  const safeValue = summaryValue(value);
  return `${typeof safeValue}:${String(safeValue)}`;
}

function resultSummaryNextSteps(
  rowCount: number,
  maskedColumns: string[],
  timeColumns: string[],
  dimensionColumns: string[]
): string[] {
  const steps: string[] = [];
  if (rowCount === 0) {
    steps.push("Check whether filters are too narrow or whether the selected schema/table is correct.");
  }
  if (timeColumns.length > 0) {
    steps.push(`Use ${timeColumns[0]} for bounded recent-data queries when investigating changes.`);
  }
  if (dimensionColumns.length > 0) {
    steps.push(`Use ${dimensionColumns[0]} for grouped counts or value-distribution checks.`);
  }
  if (maskedColumns.length > 0) {
    steps.push("Masked columns were summarized without exposing raw values.");
  }
  if (steps.length === 0) {
    steps.push("Use ob_query_refine to add filters, ordering, or pagination before running a follow-up query.");
  }
  return steps;
}

function renderCsvPreview(rows: unknown[], columnNames: string[]): string {
  if (columnNames.length === 0) {
    return "";
  }
  const header = columnNames.map(csvCell).join(",");
  const body = rows.map((row) => {
    const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    return columnNames.map((column) => csvCell(formatPreviewValue(record[column]))).join(",");
  });
  return [header, ...body].join("\n");
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ");
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
