import type { ObConfig } from "../../config.js";
import { shouldMaskColumnValue } from "../../query/output.js";
import { schemaColumnRoles } from "./schema-map.js";

export interface ProfileColumnMetadata {
  name: string;
  dataType?: string;
  nullable?: boolean;
  comment?: string;
  roles?: string[];
}

export function columnTypeLabel(mode: ObConfig["compatibility"], record: Record<string, unknown>): string | undefined {
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

export function normalizeTableName(mode: ObConfig["compatibility"], value: string): string {
  return mode === "oracle" ? value.trim().toUpperCase() : value.trim().toLowerCase();
}

export function stringRecordValue(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = keys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : undefined;
}

export function numberRecordValue(record: Record<string, unknown>, ...keys: string[]): number | undefined {
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

export function selectProfileColumns(
  rows: unknown[],
  mode: ObConfig["compatibility"],
  requestedColumns: string[] | undefined,
  maxColumns: number
): ProfileColumnMetadata[] {
  const cappedMax = Math.max(1, Math.min(maxColumns, 50));
  const metadata = rows
    .map((row) => profileColumnMetadata(row, mode))
    .filter((row): row is ProfileColumnMetadata => Boolean(row));
  if (metadata.length === 0) {
    throw new Error("No visible columns are available for ob_profile_columns.");
  }

  if (requestedColumns && requestedColumns.length > 0) {
    if (requestedColumns.length > cappedMax) {
      throw new Error(`Requested ${requestedColumns.length} columns, but maxColumns is ${cappedMax}.`);
    }
    const byName = new Map(metadata.map((column) => [normalizeTableName(mode, column.name), column]));
    const selected: ProfileColumnMetadata[] = [];
    const seen = new Set<string>();
    for (const requested of requestedColumns) {
      const key = normalizeTableName(mode, requested);
      const column = byName.get(key);
      if (!column) {
        throw new Error(`Unknown column "${requested}" or column is hidden by policy.`);
      }
      if (!seen.has(key)) {
        selected.push(column);
        seen.add(key);
      }
    }
    return selected;
  }

  return metadata.slice(0, cappedMax);
}

export function profileColumnMetadata(
  row: unknown,
  mode: ObConfig["compatibility"]
): ProfileColumnMetadata | undefined {
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

export function enrichColumnProfile(
  profileResult: unknown,
  metadata: ProfileColumnMetadata | undefined,
  config: ObConfig,
  schema: string | undefined,
  table: string
): Record<string, unknown> {
  const record = profileResult && typeof profileResult === "object" && !Array.isArray(profileResult)
    ? profileResult as Record<string, unknown>
    : {};
  const columnName = stringRecordValue(record, "column", "COLUMN") ?? metadata?.name ?? "";
  const roles = metadata?.roles ?? schemaColumnRoles(columnName, false);
  const typeCategory = profileColumnTypeCategory(metadata?.dataType);
  const sampledRows = numberRecordValue(record, "sampledRows", "sampled_rows") ?? 0;
  const distinct = record.distinct && typeof record.distinct === "object" && !Array.isArray(record.distinct)
    ? numberRecordValue(record.distinct as Record<string, unknown>, "value")
    : undefined;
  return {
    ...record,
    dataType: metadata?.dataType,
    nullable: metadata?.nullable,
    comment: metadata?.comment,
    roles,
    typeCategory,
    profileStrategy: profileColumnStrategy(typeCategory, metadata?.dataType, roles),
    enumCandidate: profileColumnEnumCandidate(columnName, typeCategory, distinct, sampledRows, roles),
    masked: shouldMaskColumnValue(columnName, config, schema, table)
  };
}

export function profileColumnTypeCategory(dataType: string | undefined): string {
  const normalized = (dataType ?? "").toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (/(date|time|timestamp|year)/.test(normalized)) {
    return "temporal";
  }
  if (/(tinyint\(1\)|boolean|bool|bit)/.test(normalized)) {
    return "boolean";
  }
  if (/(int|number|numeric|decimal|double|float|real)/.test(normalized)) {
    return "numeric";
  }
  if (/(enum|set)/.test(normalized)) {
    return "enum";
  }
  if (/(char|text|clob|string)/.test(normalized)) {
    return "string";
  }
  if (/(json|xml)/.test(normalized)) {
    return "semi_structured";
  }
  if (/(blob|binary|raw|long raw)/.test(normalized)) {
    return "binary";
  }
  return "other";
}

function profileColumnStrategy(typeCategory: string, dataType: string | undefined, roles: string[]) {
  const comparable = !["binary", "semi_structured"].includes(typeCategory) && isProfileComparableTypeLabel(dataType);
  return {
    nulls: true,
    distinct: comparable,
    topValues: comparable,
    sampleValues: comparable,
    minMax: comparable,
    numericRange: typeCategory === "numeric",
    timeRange: typeCategory === "temporal",
    textLength: typeCategory === "string",
    dimensionSignals: roles.includes("status") || typeCategory === "enum" || typeCategory === "boolean",
    notes: profileColumnStrategyNotes(typeCategory, comparable)
  };
}

function isProfileComparableTypeLabel(dataType: string | undefined): boolean {
  return !/(blob|clob|long|raw|binary|geometry|json|xml)/i.test(dataType ?? "");
}

function profileColumnStrategyNotes(typeCategory: string, comparable: boolean): string[] {
  if (!comparable) {
    return ["Value preview, distinct count, top values, and min/max can be skipped for large or non-comparable types."];
  }
  if (typeCategory === "temporal") {
    return ["Temporal fields include min/max as a sampled time range."];
  }
  if (typeCategory === "numeric") {
    return ["Numeric fields include sampled min/max as a value range."];
  }
  if (typeCategory === "string" || typeCategory === "enum") {
    return ["String-like fields include sampled top values and examples, with masking applied before output."];
  }
  return [];
}

function profileColumnEnumCandidate(
  columnName: string,
  typeCategory: string,
  distinct: number | undefined,
  sampledRows: number,
  roles: string[]
) {
  const evidence: string[] = [];
  let confidence = 0;
  if (typeCategory === "enum" || typeCategory === "boolean") {
    confidence += 0.45;
    evidence.push(`Type category is ${typeCategory}.`);
  }
  if (roles.includes("status")) {
    confidence += 0.35;
    evidence.push("Column name suggests a status, type, category, or dimension field.");
  }
  if (distinct != null && sampledRows > 0) {
    const ratioValue = distinct / sampledRows;
    if (distinct <= 20 && ratioValue <= 0.4) {
      confidence += 0.25;
      evidence.push(`Sample distinct count is ${distinct} of ${sampledRows} rows.`);
    }
  }
  if (/(status|state|type|category|kind|level|channel|region|flag)/i.test(columnName)) {
    confidence += 0.2;
    evidence.push("Column name matches common dimension naming.");
  }
  const cappedConfidence = Math.min(0.98, Number(confidence.toFixed(2)));
  return {
    likely: cappedConfidence >= 0.45,
    confidence: cappedConfidence,
    evidence
  };
}

export function sameColumnName(mode: ObConfig["compatibility"], left: string, right: string): boolean {
  return normalizeTableName(mode, left) === normalizeTableName(mode, right);
}

export function profileWarnings(
  baseWarnings: string[],
  rowEstimate: number | undefined,
  rowLimit: number,
  selectedColumnCount: number,
  visibleColumnCount: number
): string[] {
  const warnings = new Set(baseWarnings);
  warnings.add("Column profiling uses a bounded sample; returned counts and value distributions are not full-table exact values.");
  if (rowEstimate != null && rowEstimate > rowLimit) {
    warnings.add(`Table row estimate is ${rowEstimate}; profiling was limited to ${rowLimit} rows.`);
  }
  if (visibleColumnCount > selectedColumnCount) {
    warnings.add(`Only ${selectedColumnCount} of ${visibleColumnCount} visible columns were profiled. Pass columns or maxColumns to change scope.`);
  }
  return [...warnings];
}

export function selectTableProfileColumns(
  columns: Array<{ name: string; type?: string; nullable?: boolean; roles: string[]; masked: boolean }>,
  primaryKeys: string[],
  maxColumns: number
): Array<{ name: string; type?: string; nullable?: boolean; roles: string[]; masked: boolean }> {
  const cappedMax = Math.max(1, Math.min(maxColumns, 50));
  const primaryKeySet = new Set(primaryKeys.map((column) => column.toLowerCase()));
  return columns
    .map((column, index) => ({
      column,
      index,
      score: tableProfileColumnScore(column, primaryKeySet)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, cappedMax)
    .map((item) => item.column);
}

export function tableProfileMaskedColumns(
  result: { schema?: string; table: string; columns: unknown[] },
  metadataColumns: Array<{ name: string; type?: string; nullable?: boolean; comment?: string; roles: string[] }>,
  config: ObConfig,
  schema: string | undefined,
  table: string
): Array<Record<string, unknown>> {
  const metadata = new Map(metadataColumns.map((column) => [normalizeTableName(config.compatibility, column.name), column]));
  const enriched = {
    ...result,
    columns: result.columns.map((profileResult) => {
      const record = profileResult && typeof profileResult === "object" && !Array.isArray(profileResult)
        ? profileResult as Record<string, unknown>
        : {};
      const columnName = stringRecordValue(record, "column", "COLUMN") ?? "";
      const column = metadata.get(normalizeTableName(config.compatibility, columnName));
      return enrichColumnProfile(
        record,
        column
          ? {
              name: column.name,
              dataType: column.type,
              nullable: column.nullable,
              comment: column.comment,
              roles: column.roles
            }
          : undefined,
        config,
        schema,
        table
      );
    })
  };
  const masked = maskColumnProfileResult(enriched, config, schema, table);
  return (masked.columns ?? [])
    .filter((column) => Boolean(column && typeof column === "object" && !Array.isArray(column)))
    .map((column) => column as Record<string, unknown>);
}

export function tableProfileWarnings(
  metadataWarnings: string[],
  columnWarnings: string[],
  rowEstimate: number | undefined,
  rowLimit: number,
  visibleColumnCount: number,
  selectedColumnCount: number,
  includeColumnProfiles: boolean
): string[] {
  const warnings = new Set<string>([
    ...metadataWarnings,
    ...columnWarnings,
    "Table profile combines metadata with bounded column samples; row estimates and sampled values are not full-table exact values."
  ]);
  if (!includeColumnProfiles) {
    warnings.add("Column profiling was disabled, so null overview, time ranges, and value distributions are metadata-only.");
  } else {
    for (const warning of profileWarnings([], rowEstimate, rowLimit, selectedColumnCount, visibleColumnCount)) {
      warnings.add(warning);
    }
  }
  return [...warnings];
}

export function tableProfileNullOverview(profiles: Array<Record<string, unknown>>) {
  return profiles
    .map((profile) => {
      const nulls = profile.nulls && typeof profile.nulls === "object" && !Array.isArray(profile.nulls)
        ? profile.nulls as Record<string, unknown>
        : {};
      return {
        column: stringRecordValue(profile, "column", "COLUMN") ?? "",
        nullable: Boolean(profile.nullable),
        masked: Boolean(profile.masked),
        sampledRows: numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0,
        nullCount: numberRecordValue(nulls, "count") ?? 0,
        nullRatio: numberRecordValue(nulls, "ratio") ?? 0,
        source: stringRecordValue(nulls, "source")
      };
    })
    .filter((item) => item.column)
    .sort((left, right) => right.nullRatio - left.nullRatio || right.nullCount - left.nullCount || left.column.localeCompare(right.column))
    .slice(0, 20);
}

export function tableProfileTimeFields(timeFields: string[], profiles: Array<Record<string, unknown>>) {
  return timeFields.map((column) => {
    const profile = profileByColumn(profiles, column);
    const timeRange = profile?.timeRange && typeof profile.timeRange === "object" && !Array.isArray(profile.timeRange)
      ? profile.timeRange as Record<string, unknown>
      : undefined;
    return {
      column,
      confidence: 0.72,
      evidence: ["Column name or metadata role suggests a time field."],
      sampledRows: profile ? numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0 : undefined,
      min: timeRange?.min,
      max: timeRange?.max,
      masked: profile ? Boolean(profile.masked) : undefined
    };
  });
}

export function tableProfileStatusFields(statusFields: string[], profiles: Array<Record<string, unknown>>) {
  return statusFields.map((column) => {
    const profile = profileByColumn(profiles, column);
    const distinct = profile?.distinct && typeof profile.distinct === "object" && !Array.isArray(profile.distinct)
      ? profile.distinct as Record<string, unknown>
      : undefined;
    return {
      column,
      confidence: 0.72,
      evidence: ["Column name or metadata role suggests a status or dimension field."],
      sampledRows: profile ? numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0 : undefined,
      distinct: distinct ? { value: numberRecordValue(distinct, "value"), exact: false } : undefined,
      topValues: Array.isArray(profile?.topValues) ? profile?.topValues : undefined,
      masked: profile ? Boolean(profile.masked) : undefined
    };
  });
}

export function tableProfileIndexSummary(indexes: unknown[]) {
  const grouped = new Map<string, { name: string; unique?: boolean; type?: string; columns: string[] }>();
  for (const row of indexes) {
    const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    const name = stringRecordValue(record, "index_name", "INDEX_NAME");
    const column = stringRecordValue(record, "column_name", "COLUMN_NAME");
    if (!name) {
      continue;
    }
    const nonUnique = record.non_unique ?? record.NON_UNIQUE;
    const uniqueness = stringRecordValue(record, "uniqueness", "UNIQUENESS");
    const existing = grouped.get(name) ?? {
      name,
      unique: uniqueness ? uniqueness.toUpperCase() === "UNIQUE" : nonUnique == null ? undefined : String(nonUnique) === "0",
      type: stringRecordValue(record, "index_type", "INDEX_TYPE"),
      columns: []
    };
    if (column) {
      existing.columns = uniqueStrings([...existing.columns, column]);
    }
    grouped.set(name, existing);
  }
  return [...grouped.values()].slice(0, 20);
}

export function maskColumnProfileResult<T extends { columns?: unknown[] }>(
  result: T,
  config: ObConfig,
  schema: string | undefined,
  table: string
): T {
  if (!Array.isArray(result.columns)) {
    return result;
  }
  return {
    ...result,
    columns: result.columns.map((column) => maskColumnProfile(column, config, schema, table))
  };
}

function maskColumnProfile(
  column: unknown,
  config: ObConfig,
  schema: string | undefined,
  table: string
): unknown {
  if (!column || typeof column !== "object" || Array.isArray(column)) {
    return column;
  }
  const record = column as Record<string, unknown>;
  const columnName = stringRecordValue(record, "column", "COLUMN") ?? "";
  const masked = Boolean(record.masked) || shouldMaskColumnValue(columnName, config, schema, table);
  if (!masked) {
    return { ...record, masked };
  }
  const timeRange = record.timeRange && typeof record.timeRange === "object" && !Array.isArray(record.timeRange)
    ? {
        ...(record.timeRange as Record<string, unknown>),
        min: maskProfileValue((record.timeRange as Record<string, unknown>).min),
        max: maskProfileValue((record.timeRange as Record<string, unknown>).max)
      }
    : record.timeRange;
  return {
    ...record,
    masked,
    min: maskProfileValue(record.min),
    max: maskProfileValue(record.max),
    timeRange,
    topValues: Array.isArray(record.topValues)
      ? record.topValues.map((item) => {
          const valueRecord = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
          return { ...valueRecord, value: maskProfileValue(valueRecord.value) };
        })
      : record.topValues,
    sampleValues: Array.isArray(record.sampleValues) ? record.sampleValues.map(maskProfileValue) : record.sampleValues
  };
}

function maskProfileValue(value: unknown): unknown {
  return value == null ? value : "***MASKED***";
}

function tableProfileColumnScore(
  column: { name: string; type?: string; nullable?: boolean; roles: string[] },
  primaryKeySet: Set<string>
): number {
  let score = 0;
  if (primaryKeySet.has(column.name.toLowerCase()) || column.roles.includes("primary_key")) {
    score += 100;
  }
  if (column.roles.includes("time")) {
    score += 90;
  }
  if (column.roles.includes("status")) {
    score += 85;
  }
  if (column.nullable) {
    score += 55;
  }
  if (column.roles.includes("identifier")) {
    score += 35;
  }
  if (/(int|number|decimal|numeric|float|double|date|time|timestamp|char|text)/i.test(column.type ?? "")) {
    score += 20;
  }
  return score;
}

function profileByColumn(profiles: Array<Record<string, unknown>>, column: string): Record<string, unknown> | undefined {
  return profiles.find((profile) => {
    const name = stringRecordValue(profile, "column", "COLUMN");
    return Boolean(name && name.toLowerCase() === column.toLowerCase());
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
