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

export function rowsToOutput(
  result: QueryResult,
  fields: FieldPacket[] | undefined,
  maxRows: number,
  maxBytes = Number.POSITIVE_INFINITY
): QueryOutput {
  const rows = Array.isArray(result) ? Array.from(result as unknown[]) : [result];
  const fieldMetadata = fields?.map((field) => ({
    name: field.name,
    table: field.table || undefined,
    database: field.db || undefined,
    columnType: field.columnType
  }));
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined;
  const maxValueBytes = byteLimit ? Math.max(256, Math.min(64 * 1024, Math.floor(byteLimit / 4))) : undefined;
  const outputRows: unknown[] = [];
  let truncated = rows.length > maxRows;
  let rowBytes = 0;
  const metadataBytes = byteLimit
    ? Buffer.byteLength(JSON.stringify({ rowCount: rows.length, rows: [], truncated: true, fields: fieldMetadata }), "utf8")
    : 0;

  for (const row of rows.slice(0, maxRows)) {
    const valueTruncation = { value: false };
    const normalized = normalizeForJson(row, maxValueBytes, valueTruncation);
    if (valueTruncation.value) {
      truncated = true;
    }
    const nextRowBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8") + (outputRows.length > 0 ? 1 : 0);
    if (byteLimit && metadataBytes + rowBytes + nextRowBytes > byteLimit) {
      truncated = true;
      break;
    }
    outputRows.push(normalized);
    rowBytes += nextRowBytes;
  }

  const output: QueryOutput = {
    rowCount: rows.length,
    rows: outputRows,
    truncated,
    fields: fieldMetadata
  };

  while (byteLimit && output.rows.length > 0 && jsonByteLength(output) > byteLimit) {
    output.rows.pop();
    output.truncated = true;
  }

  return output;
}

export function jsonText(value: unknown): string {
  return JSON.stringify(normalizeForJson(value), null, 2);
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(jsonText(value), "utf8");
}

export function assertJsonByteLimit(value: unknown, maxBytes: number): void {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) {
    throw new Error(`Result size ${bytes} bytes exceeds configured OB_MAX_RESULT_BYTES=${maxBytes}.`);
  }
}

function normalizeForJson(value: unknown, maxStringBytes?: number, valueTruncation?: { value: boolean }): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    const output = truncateStringBytes(value, maxStringBytes);
    if (output !== value && valueTruncation) {
      valueTruncation.value = true;
    }
    return output;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    const encoded = value.toString("base64");
    const output = truncateStringBytes(encoded, maxStringBytes);
    if (output !== encoded && valueTruncation) {
      valueTruncation.value = true;
    }
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForJson(item, maxStringBytes, valueTruncation));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = normalizeForJson(nested, maxStringBytes, valueTruncation);
    }
    return output;
  }

  return value;
}

function truncateStringBytes(value: string, maxBytes: number | undefined): string {
  if (!maxBytes || maxBytes <= 0 || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const suffix = "...[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const targetBytes = Math.max(0, maxBytes - suffixBytes);
  let output = "";
  let usedBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > targetBytes) {
      break;
    }
    output += char;
    usedBytes += charBytes;
  }
  return `${output}${suffix}`;
}
