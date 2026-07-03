import type { ObConfig } from "../config.js";
import { jsonByteLength, type QueryOutput } from "../format.js";
import { isDeniedColumn, isMaskedColumn } from "../policy.js";

const SENSITIVE_SAMPLE_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential|session|cookie|email|phone|mobile|id[_-]?card|ssn)/i;

export function pagedQueryWarnings(
  sql: string,
  requestedPageSize: number | undefined,
  effectivePageSize: number,
  fetchRows: number,
  orderBy: string | undefined
): string[] {
  const warnings: string[] = [];
  if (!/\border\s+by\b/i.test(sql) && !orderBy) {
    warnings.push("No ORDER BY was provided. Page order may be unstable.");
  }
  if (requestedPageSize && requestedPageSize !== effectivePageSize) {
    warnings.push(`pageSize was capped to ${effectivePageSize} by the configured row limit.`);
  }
  if (fetchRows === effectivePageSize) {
    warnings.push("hasMore may be false when the configured row limit does not allow fetching an extra row.");
  }
  return warnings;
}

export function queryResultWarnings(sql: string, output: QueryOutput, config: ObConfig): string[] {
  const warnings: string[] = [];
  if (output.truncated) {
    warnings.push("Result was truncated by the configured row limit.");
  }
  if (!/\border\s+by\b/i.test(sql) && output.rows.length > 1) {
    warnings.push("No ORDER BY was detected. Result order may be unstable.");
  }
  if (jsonByteLength(output) > config.maxResultBytes * 0.8) {
    warnings.push("Result size is close to OB_MAX_RESULT_BYTES.");
  }
  return warnings;
}

export function enrichQueryOutput(output: QueryOutput, config: ObConfig, warnings: string[] = []) {
  const columns = queryOutputColumns(output, config);
  const maskedRows = maskQueryRows(output.rows, columns);
  const maskedColumns = columns.filter((column) => column.masked).map((column) => column.name);
  const combinedWarnings = [...warnings];
  if (maskedColumns.length > 0) {
    combinedWarnings.push(`Masked result columns: ${maskedColumns.join(", ")}.`);
  }
  return {
    ...output,
    rows: maskedRows,
    columns,
    markdownPreview: renderMarkdownPreview(maskedRows, columns.map((column) => column.name)),
    warnings: [...new Set(combinedWarnings)]
  };
}

export function queryOutputColumns(output: QueryOutput, config: ObConfig) {
  if (output.fields && output.fields.length > 0) {
    return output.fields.map((field) => ({
      name: field.name,
      table: field.table,
      schema: field.database,
      columnType: field.columnType,
      masked: shouldMaskColumnValue(field.name, config, field.database, field.table)
    }));
  }

  const firstRow = output.rows.find((row) => row && typeof row === "object" && !Array.isArray(row));
  if (!firstRow || typeof firstRow !== "object" || Array.isArray(firstRow)) {
    return [];
  }
  return Object.keys(firstRow as Record<string, unknown>).map((name) => ({
    name,
    masked: shouldMaskColumnValue(name, config)
  }));
}

export function maskQueryRows(rows: unknown[], columns: Array<{ name: string; masked: boolean }>): unknown[] {
  if (columns.length === 0) {
    return rows;
  }
  const masked = new Set(columns.filter((column) => column.masked).map((column) => column.name));
  if (masked.size === 0) {
    return rows;
  }
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return row;
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      output[key] = masked.has(key) ? "***MASKED***" : value;
    }
    return output;
  });
}

export function renderMarkdownPreview(rows: unknown[], columnNames: string[]): string {
  if (rows.length === 0 || columnNames.length === 0) {
    return "";
  }
  const visibleColumns = columnNames.slice(0, 12);
  const visibleRows = rows.slice(0, 10);
  const header = `| ${visibleColumns.map(markdownCell).join(" | ")} |`;
  const divider = `| ${visibleColumns.map(() => "---").join(" | ")} |`;
  const body = visibleRows.map((row) => {
    const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    return `| ${visibleColumns.map((column) => markdownCell(formatPreviewValue(record[column]))).join(" | ")} |`;
  });
  return [header, divider, ...body].join("\n");
}

export function effectiveRowLimit(requested: number | undefined, config: ObConfig): number {
  return Math.min(requested ?? config.maxRows, config.maxRows);
}

export function maskOutput(output: QueryOutput, config: ObConfig, schema?: string, table?: string): QueryOutput {
  return {
    ...output,
    rows: output.rows.map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return row;
      }
      const masked: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        masked[key] = shouldMaskColumnValue(key, config, schema, table) ? "***MASKED***" : value;
      }
      return masked;
    })
  };
}

export function shouldMaskColumnValue(column: string, config: ObConfig, schema?: string, table?: string): boolean {
  return (
    isMaskedColumn(column, config.policy, schema, table) ||
    isDeniedColumn(column, config.policy) ||
    SENSITIVE_SAMPLE_PATTERN.test(column)
  );
}

export function formatPreviewValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function markdownCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}
