import type { FieldPacket, QueryResult } from "mysql2/promise";

export interface QueryOutput {
  rowCount: number;
  rows: unknown[];
  truncated: boolean;
  fields?: Array<{
    name: string;
    table?: string;
    database?: string;
    columnType?: number;
  }>;
}

export function rowsToOutput(result: QueryResult, fields: FieldPacket[] | undefined, maxRows: number): QueryOutput {
  const rows = Array.isArray(result) ? Array.from(result as unknown[]) : [result];
  const slicedRows = rows.slice(0, maxRows);

  return {
    rowCount: rows.length,
    rows: normalizeForJson(slicedRows) as unknown[],
    truncated: rows.length > maxRows,
    fields: fields?.map((field) => ({
      name: field.name,
      table: field.table || undefined,
      database: field.db || undefined,
      columnType: field.columnType
    }))
  };
}

export function jsonText(value: unknown): string {
  return JSON.stringify(normalizeForJson(value), null, 2);
}

function normalizeForJson(value: unknown): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = normalizeForJson(nested);
    }
    return output;
  }

  return value;
}
