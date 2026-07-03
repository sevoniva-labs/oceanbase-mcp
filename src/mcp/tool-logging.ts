export interface ToolTextResult {
  content: Array<{
    text?: string;
  }>;
}

export function resultTextBytes(result: ToolTextResult): number {
  return result.content.reduce((sum, item) => sum + Buffer.byteLength(item.text ?? "", "utf8"), 0);
}

export function resultDiagnostics(result: ToolTextResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (!text) {
    return emptyDiagnostics();
  }
  try {
    return payloadDiagnostics(JSON.parse(text));
  } catch {
    return emptyDiagnostics();
  }
}

function payloadDiagnostics(payload: unknown): Record<string, unknown> {
  const warnings = payloadWarnings(payload);
  const truncated = payloadTruncated(payload);
  const rowsRead = payloadRowsRead(payload);
  const objectsRead = payloadObjectsRead(payload);
  return {
    warningCount: warnings.length,
    warnings,
    truncated,
    ...(rowsRead != null ? { rowsRead } : {}),
    ...(objectsRead != null ? { objectsRead } : {})
  };
}

function payloadWarnings(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const warnings = (payload as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 20);
}

function payloadTruncated(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const nestedContainers = ["resultState", "stats", "executionSummary"];
  return Boolean(
    record.truncated ||
    record.columnsTruncated ||
    record.tablesTruncated ||
    nestedContainers.some((key) => {
      const value = record[key];
      return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).truncated);
    })
  );
}

function payloadRowsRead(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["rowCount", "returnedRows", "sampledRows"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  if (Array.isArray(record.rows)) {
    return record.rows.length;
  }
  return undefined;
}

function payloadObjectsRead(payload: unknown): number | undefined {
  if (Array.isArray(payload)) {
    return payload.length;
  }
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ["objectCount", "tableCount", "columnCount", "relationshipCount", "returnedColumns"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  if (Array.isArray(record.columns)) {
    return record.columns.length;
  }
  if (Array.isArray(record.tables)) {
    return record.tables.length;
  }
  if (Array.isArray(record.relationships)) {
    return record.relationships.length;
  }
  return undefined;
}

function emptyDiagnostics(): Record<string, unknown> {
  return {
    warningCount: 0,
    warnings: [],
    truncated: false
  };
}
