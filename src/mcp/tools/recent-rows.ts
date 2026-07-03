import { z } from "zod";

import type { ObConfig } from "../../config.js";
import { describeTable, runReadOnlyQuery, type SqlParam } from "../../db.js";
import { assertJsonByteLimit } from "../../format.js";
import {
  assertOutputAllowed,
  assertSqlPolicy,
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import {
  effectiveRowLimit,
  enrichQueryOutput,
  shouldMaskColumnValue
} from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { assertSqlInputLimits } from "../../sql.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  buildSelectColumnInfos,
  buildStructuredSelect,
  getBuildColumn
} from "../query-builder.js";
import { profileInput } from "../schemas.js";
import { toResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerRecentRowsTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_find_recent_rows",
    {
      title: "Find Recent Rows",
      description: "Read recent rows from an allowed table using an explicit or metadata-detected time column with safe pagination.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        timeColumn: z.string().min(1).optional(),
        columns: z.array(z.string().min(1)).max(100).optional(),
        page: z.number().int().positive().optional().default(1),
        pageSize: z.number().int().positive().max(1_000).optional()
      }
    },
    async ({ profile, table, schema, timeColumn, columns, page = 1, pageSize }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const resolvedTime = resolveRecentRowsTimeColumn(visibleColumns, selected.config, effectiveSchema, table, timeColumn);
      const requestedColumns = recentRowsProjection(columns, resolvedTime.column);
      const built = buildStructuredSelect(
        selected.config,
        effectiveSchema,
        table,
        visibleColumns,
        {
          columns: requestedColumns,
          filters: [],
          orderBy: [{ column: resolvedTime.column, direction: "desc" }],
          pageSize,
          page
        }
      );
      const sqlParams = built.params as SqlParam[];
      assertSqlInputLimits(built.sql, sqlParams, selected.config);
      assertSqlPolicy(built.sql, policyContext(selected.config));
      const output = await withQuerySlot(selected, () =>
        runReadOnlyQuery(
          selected.pool,
          selected.config.compatibility,
          built.sql,
          sqlParams,
          built.pagination.pageSize,
          selected.config.queryTimeoutMs,
          selected.config.enforceReadOnlyTransaction,
          selected.config.maxResultBytes
        )
      );
      assertOutputAllowed(output, selected.config.policy);
      const visibleOutput = enrichQueryOutput(
        output,
        selected.config,
        recentRowsWarnings(built.warnings, resolvedTime, output.truncated)
      );
      const result = {
        mode: selected.config.compatibility,
        schema: effectiveSchema,
        table,
        timeColumn: resolvedTime,
        sql: built.sql,
        paramCount: sqlParams.length,
        page: built.pagination.page,
        pageSize: built.pagination.pageSize,
        columns: visibleOutput.columns,
        rows: visibleOutput.rows,
        markdownPreview: visibleOutput.markdownPreview,
        truncated: visibleOutput.truncated,
        warnings: visibleOutput.warnings,
        executed: true
      };
      assertJsonByteLimit(result, selected.config.maxResultBytes);
      return toResult(result);
    }
  );
}

function resolveRecentRowsTimeColumn(
  rows: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string,
  requestedTimeColumn: string | undefined
) {
  if (requestedTimeColumn) {
    const column = getBuildColumn(config, buildSelectColumnInfos(config, schema, table, rows), requestedTimeColumn);
    const signal = timeColumnSignal(column.name, column.type, column.comment);
    return {
      column: column.name,
      source: "explicit",
      confidence: Math.max(signal.confidence, 0.5),
      kind: signal.kind,
      evidence: signal.evidence.length > 0 ? signal.evidence : ["Time column was supplied explicitly."],
      dataType: column.type,
      masked: column.masked
    };
  }
  const candidates = detectTimeColumnCandidates(rows, config, schema, table, 5);
  const best = candidates[0];
  if (!best || best.confidence < 0.5) {
    throw new Error("No reliable time column was detected. Pass timeColumn explicitly.");
  }
  return {
    column: best.column,
    source: "detected",
    confidence: best.confidence,
    kind: best.kind,
    evidence: best.evidence,
    dataType: best.dataType,
    masked: best.masked,
    alternatives: candidates.slice(1, 5).map((candidate) => ({
      column: candidate.column,
      kind: candidate.kind,
      confidence: candidate.confidence,
      evidence: candidate.evidence
    }))
  };
}

function recentRowsProjection(columns: string[] | undefined, timeColumn: string): string[] | undefined {
  if (!columns || columns.length === 0) {
    return undefined;
  }
  return uniqueStrings([timeColumn, ...columns]);
}

function recentRowsWarnings(baseWarnings: string[], timeColumn: { source: string; alternatives?: unknown[] }, truncated: boolean): string[] {
  const warnings = new Set(baseWarnings);
  if (timeColumn.source === "detected") {
    warnings.add("Time column was selected from metadata detection; pass timeColumn explicitly if this is not the business time field.");
  }
  if (Array.isArray(timeColumn.alternatives) && timeColumn.alternatives.length > 0) {
    warnings.add("Other time-like columns were found; review alternatives before using this query for business decisions.");
  }
  if (truncated) {
    warnings.add("Rows were truncated by the configured row or output limit.");
  }
  return [...warnings];
}

function detectTimeColumnCandidates(
  rows: unknown[],
  config: ObConfig,
  schema: string | undefined,
  table: string,
  maxColumns: number
) {
  return rows
    .map((row, index) => {
      const metadata = profileColumnMetadata(row, config.compatibility);
      if (!metadata) {
        return undefined;
      }
      const signal = timeColumnSignal(metadata.name, metadata.dataType, metadata.comment);
      if (signal.confidence < 0.35) {
        return undefined;
      }
      return {
        column: metadata.name,
        kind: signal.kind,
        confidence: signal.confidence,
        evidence: signal.evidence,
        dataType: metadata.dataType,
        nullable: metadata.nullable,
        comment: metadata.comment,
        masked: shouldMaskColumnValue(metadata.name, config, schema, table),
        ordinalPosition: numberRecordValue(row as Record<string, unknown>, "ordinal_position", "ORDINAL_POSITION", "column_id", "COLUMN_ID") ?? index + 1
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.confidence - left.confidence || left.ordinalPosition - right.ordinalPosition)
    .slice(0, Math.max(1, Math.min(maxColumns, 50)));
}

function timeColumnSignal(
  columnName: string,
  dataType: string | undefined,
  comment: string | undefined
): { kind: string; confidence: number; evidence: string[] } {
  const normalized = columnName.trim().toLowerCase();
  const commentText = (comment ?? "").trim().toLowerCase();
  const typeCategory = profileColumnTypeCategory(dataType);
  const evidence: string[] = [];
  let confidence = 0;
  let kind = "generic_time";

  if (typeCategory === "temporal") {
    confidence += 0.35;
    evidence.push(`Data type "${dataType}" is temporal.`);
  }
  if (/^(created_at|created_time|create_time|gmt_create|insert_time|created)$/.test(normalized)) {
    confidence += 0.5;
    kind = "created_time";
    evidence.push("Column name matches common create-time naming.");
  } else if (/^(updated_at|updated_time|update_time|modified_at|modified_time|gmt_modified|last_update|last_modified)$/.test(normalized)) {
    confidence += 0.5;
    kind = "updated_time";
    evidence.push("Column name matches common update-time naming.");
  } else if (/(event|occur|trade|order|pay|paid|biz|business|effective|start|end).*(time|date|day)$/.test(normalized) || /^(biz_date|business_date)$/.test(normalized)) {
    confidence += 0.45;
    kind = "business_time";
    evidence.push("Column name suggests a business event time.");
  } else if (/(^|_)(time|date|day|timestamp)$/.test(normalized) || /(time|date|timestamp)/.test(normalized)) {
    confidence += 0.2;
    evidence.push("Column name contains a time-related token.");
  }
  if (/(created|create time|updated|update time|modified|event time|business time|occurred|trade time|pay time)/.test(commentText)) {
    confidence += 0.15;
    evidence.push("Column comment contains time-related wording.");
  }
  return {
    kind,
    confidence: Math.min(0.98, Number(confidence.toFixed(2))),
    evidence
  };
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

function profileColumnTypeCategory(dataType: string | undefined): string {
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
