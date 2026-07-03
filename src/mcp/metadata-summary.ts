export function inferTablePurpose(
  table: string,
  tableComment: string | undefined,
  columns: Array<{ name: string; comment?: string; roles: string[] }>
) {
  const evidence: Array<{ source: string; value: string; reason: string }> = [];
  if (tableComment) {
    evidence.push({
      source: "table_comment",
      value: tableComment,
      reason: "Uses database table comment."
    });
  }
  evidence.push({
    source: "table_name",
    value: table,
    reason: "Uses visible table name."
  });
  for (const column of columns.filter((item) => item.comment).slice(0, 5)) {
    evidence.push({
      source: "column_comment",
      value: `${column.name}: ${column.comment}`,
      reason: "Uses visible column comment."
    });
  }
  const roleSummary = [
    columns.some((column) => column.roles.includes("primary_key")) ? "primary key" : undefined,
    columns.some((column) => column.roles.includes("time")) ? "time fields" : undefined,
    columns.some((column) => column.roles.includes("status")) ? "status or dimension fields" : undefined
  ].filter((item): item is string => Boolean(item));

  return {
    inferred: true,
    summary: tableComment
      ? `Likely purpose is described by the table comment: ${tableComment}`
      : `Likely represents data named by table "${table}".`,
    confidence: tableComment ? 0.78 : 0.58,
    roleSummary,
    evidence: evidence.slice(0, 10)
  };
}

export function tableSummaryQueryEntryPoints(
  primaryKeys: string[],
  timeFields: string[],
  statusFields: string[],
  relationSummary: {
    relations: Array<{
      direction: "outbound" | "inbound";
      sourceTable: string;
      sourceColumns: string[];
      targetTable: string;
      targetColumns: string[];
      confidence: number;
    }>;
  } | undefined
) {
  const entries = [];
  if (primaryKeys.length > 0) {
    entries.push({
      type: "primary_key_lookup",
      fields: primaryKeys,
      reason: "Primary-key metadata is available."
    });
  }
  if (timeFields.length > 0) {
    entries.push({
      type: "time_range",
      fields: timeFields.slice(0, 5),
      reason: "Time-like fields were detected from column names."
    });
  }
  if (statusFields.length > 0) {
    entries.push({
      type: "status_filter",
      fields: statusFields.slice(0, 5),
      reason: "Status or dimension-like fields were detected from column names."
    });
  }
  if (relationSummary && relationSummary.relations.length > 0) {
    entries.push({
      type: "join",
      fields: relationSummary.relations.slice(0, 5).map((relation) => ({
        table: relation.direction === "outbound" ? relation.targetTable : relation.sourceTable,
        columns: relation.direction === "outbound" ? relation.sourceColumns : relation.targetColumns,
        confidence: relation.confidence
      })),
      reason: "Relationship metadata or conservative relationship inference is available."
    });
  }
  entries.push({
    type: "paged_scan",
    fields: primaryKeys.length > 0 ? primaryKeys : timeFields.slice(0, 1),
    reason: "Use only with explicit columns, a row limit, and stable ORDER BY when available."
  });
  return entries;
}

export function mapperIndexSummary(rows: unknown[]): Array<{ name: string; unique?: boolean; columns: string[] }> {
  const grouped = new Map<string, { unique?: boolean; columns: string[] }>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const name = stringRecordValue(record, "index_name", "INDEX_NAME");
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name || !column) {
      continue;
    }
    const uniqueness = stringRecordValue(record, "uniqueness", "UNIQUENESS");
    const nonUnique = numberRecordValue(record, "non_unique", "NON_UNIQUE");
    const existing = grouped.get(name) ?? { unique: undefined, columns: [] };
    existing.unique = uniqueness ? uniqueness.toUpperCase() === "UNIQUE" : nonUnique != null ? nonUnique === 0 : existing.unique;
    existing.columns = uniqueStrings([...existing.columns, column]);
    grouped.set(name, existing);
  }
  return [...grouped.entries()].map(([name, value]) => ({
    name,
    unique: value.unique,
    columns: value.columns
  })).slice(0, 50);
}

export function mapperConstraintSummary(rows: unknown[]): Array<{ name: string; type?: string; columns: string[] }> {
  const grouped = new Map<string, { type?: string; columns: string[] }>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const name = stringRecordValue(record, "constraint_name", "CONSTRAINT_NAME");
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name) {
      continue;
    }
    const existing = grouped.get(name) ?? { type: stringRecordValue(record, "constraint_type", "CONSTRAINT_TYPE"), columns: [] };
    if (column) {
      existing.columns = uniqueStrings([...existing.columns, column]);
    }
    grouped.set(name, existing);
  }
  return [...grouped.entries()].map(([name, value]) => ({
    name,
    type: value.type,
    columns: value.columns
  })).slice(0, 50);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(value);
  }
  return output;
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
