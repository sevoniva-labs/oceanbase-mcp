import { z } from "zod";

import type { ObConfig } from "../../config.js";
import { describeTable } from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import { shouldMaskColumnValue } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerColumnDetectionTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_detect_time_columns",
    {
      title: "Detect Time Columns",
      description: "Detect likely create, update, and business time columns from visible table metadata.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const candidates = detectTimeColumnCandidates(
        visibleColumns,
        selected.config,
        effectiveSchema,
        table,
        maxColumns ?? 20
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          candidates,
          warnings: candidates.length === 0
            ? ["No likely time columns were detected from visible metadata. Ask the user to provide the time column explicitly."]
            : ["Time-column detection is metadata-based; verify semantics before using the column as a business time filter."]
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_detect_dimension_columns",
    {
      title: "Detect Dimension Columns",
      description: "Detect likely status, type, channel, region, flag, and category columns from visible table metadata.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        maxColumns: z.number().int().positive().max(50).optional()
      }
    },
    async ({ profile, table, schema, maxColumns }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadataRows = await withQuerySlot(selected, () =>
        describeTable(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadataRows, selected.config.policy);
      const candidates = detectDimensionColumnCandidates(
        visibleColumns,
        selected.config,
        effectiveSchema,
        table,
        maxColumns ?? 20
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          candidates,
          warnings: candidates.length === 0
            ? ["No likely dimension columns were detected from visible metadata."]
            : ["Dimension-column detection is metadata-based; verify semantics before using the column for grouping or filtering."]
        },
        selected.config
      );
    }
  );
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

function detectDimensionColumnCandidates(
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
      const signal = dimensionColumnSignal(metadata.name, metadata.dataType, metadata.comment);
      if (signal.confidence < 0.35) {
        return undefined;
      }
      return {
        column: metadata.name,
        kind: signal.kind,
        confidence: signal.confidence,
        evidence: signal.evidence,
        dataType: metadata.dataType,
        typeCategory: profileColumnTypeCategory(metadata.dataType),
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

function dimensionColumnSignal(
  columnName: string,
  dataType: string | undefined,
  comment: string | undefined
): { kind: string; confidence: number; evidence: string[] } {
  const normalized = columnName.trim().toLowerCase();
  const commentText = (comment ?? "").trim().toLowerCase();
  const typeCategory = profileColumnTypeCategory(dataType);
  const evidence: string[] = [];
  let confidence = 0;
  let kind = "generic_dimension";

  const namedKind = dimensionKindFromName(normalized);
  if (namedKind) {
    kind = namedKind;
    confidence += 0.55;
    evidence.push(`Column name matches common ${namedKind.replace(/_/g, " ")} naming.`);
  }
  if (["enum", "boolean"].includes(typeCategory)) {
    confidence += 0.3;
    evidence.push(`Type category is ${typeCategory}.`);
  } else if (typeCategory === "string" && /(char|varchar|text|string)/i.test(dataType ?? "")) {
    confidence += 0.15;
    evidence.push("String type can represent a categorical value.");
  } else if (typeCategory === "numeric" && /(tinyint|smallint|number\(1|int\(1)/i.test(dataType ?? "")) {
    confidence += 0.15;
    evidence.push("Small numeric type can represent a code or flag.");
  }
  if (/(status|state|type|category|channel|region|city|province|country|source|platform|flag|level|kind|gender)/.test(commentText)) {
    confidence += 0.15;
    evidence.push("Column comment contains dimension-related wording.");
  }
  return {
    kind,
    confidence: Math.min(0.98, Number(confidence.toFixed(2))),
    evidence
  };
}

function dimensionKindFromName(name: string): string | undefined {
  if (/(^|_)(status|state)(_|$)/.test(name)) {
    return "status";
  }
  if (/(^|_)(type|category|kind|level)(_|$)/.test(name)) {
    return "type";
  }
  if (/(^|_)(channel|source|platform|scene)(_|$)/.test(name)) {
    return "channel";
  }
  if (/(^|_)(region|city|province|country|area)(_|$)/.test(name)) {
    return "region";
  }
  if (/(^|_)(flag|enabled|disabled|deleted|active|valid)(_|$)/.test(name)) {
    return "flag";
  }
  if (/(^|_)(gender|grade|segment|bucket|group)(_|$)/.test(name)) {
    return "category";
  }
  return undefined;
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
