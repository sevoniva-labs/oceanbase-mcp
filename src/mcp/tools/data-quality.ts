import { z } from "zod";

import type { ObConfig } from "../../config.js";
import {
  getTableDdlMetadata,
  profileColumns
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { getBuildColumn } from "../query-builder.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  compactSchemaColumns,
  schemaMapPrimaryKeyColumns
} from "./schema-map.js";
import {
  normalizeTableName,
  numberRecordValue,
  selectTableProfileColumns,
  stringRecordValue,
  tableProfileMaskedColumns
} from "./profile-utils.js";

interface DataQualityColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  roles: string[];
  masked: boolean;
}

export function registerDataQualityTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_check_data_quality",
    {
      title: "Check Data Quality",
      description: "Run bounded read-only data quality checks for nulls, duplicate key risk, dimensions, and time columns.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        columns: z.array(z.string().min(1)).max(50).optional(),
        rowLimit: z.number().int().positive().max(10_000).optional(),
        maxColumns: z.number().int().positive().max(50).optional(),
        nullRatioThreshold: z.number().min(0).max(1).optional()
      }
    },
    async ({ profile, table, schema, columns, rowLimit, maxColumns, nullRatioThreshold }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );
      const visibleColumns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const visibleConstraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const compactColumns = compactSchemaColumns(visibleColumns, visibleConstraints, selected.config, metadata.schema, metadata.table);
      const primaryKeys = schemaMapPrimaryKeyColumns(visibleConstraints);
      const selectedColumns = selectDataQualityColumns(selected.config, compactColumns, primaryKeys, columns, maxColumns ?? 12);
      const profileRowLimit = Math.min(effectiveRowLimit(rowLimit, selected.config), 10_000);
      const result = selectedColumns.length > 0
        ? await withQuerySlot(selected, () =>
            profileColumns(
              selected.pool,
              selected.config.compatibility,
              metadata.schema,
              metadata.table,
              selectedColumns.map((column) => ({ name: column.name, dataType: column.type })),
              profileRowLimit,
              5,
              1,
              selected.config.queryTimeoutMs
            )
          )
        : undefined;
      const columnProfiles = result
        ? tableProfileMaskedColumns(result, compactColumns, selected.config, metadata.schema, metadata.table)
        : [];
      const checks = buildDataQualityChecks(
        columnProfiles,
        selectedColumns,
        primaryKeys,
        nullRatioThreshold ?? 0
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          primaryKeys,
          profileScope: {
            rowLimit: profileRowLimit,
            selectedColumns: selectedColumns.map((column) => column.name),
            visibleColumnCount: compactColumns.length,
            selectedColumnCount: selectedColumns.length
          },
          checks,
          summary: summarizeDataQualityChecks(checks),
          columnProfiles,
          warnings: uniqueStrings([
            ...metadata.warnings,
            ...(result?.warnings ?? []),
            "Data quality checks use bounded samples; counts and ratios are not full-table exact values.",
            ...(compactColumns.length > selectedColumns.length
              ? [`Only ${selectedColumns.length} of ${compactColumns.length} visible columns were checked. Pass columns or maxColumns to change scope.`]
              : [])
          ])
        },
        selected.config
      );
    }
  );
}

function selectDataQualityColumns(
  config: ObConfig,
  columns: DataQualityColumn[],
  primaryKeys: string[],
  requestedColumns: string[] | undefined,
  maxColumns: number
): DataQualityColumn[] {
  if (requestedColumns && requestedColumns.length > 0) {
    const available = columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      masked: column.masked
    }));
    return requestedColumns.map((column) => {
      const match = getBuildColumn(config, available, column);
      const full = columns.find((item) => normalizeTableName(config.compatibility, item.name) === normalizeTableName(config.compatibility, match.name));
      return full ?? { ...match, roles: [] };
    });
  }
  return selectTableProfileColumns(columns, primaryKeys, maxColumns);
}

function buildDataQualityChecks(
  profiles: Array<Record<string, unknown>>,
  metadataColumns: DataQualityColumn[],
  primaryKeys: string[],
  nullRatioThreshold: number
) {
  const checks: Array<Record<string, unknown>> = [];
  const primaryKeySet = new Set(primaryKeys.map((column) => column.toLowerCase()));
  for (const profile of profiles) {
    const column = stringRecordValue(profile, "column", "COLUMN") ?? "";
    if (!column) {
      continue;
    }
    const metadata = metadataColumns.find((item) => item.name.toLowerCase() === column.toLowerCase());
    const sampledRows = numberRecordValue(profile, "sampledRows", "sampled_rows") ?? 0;
    const nulls = profile.nulls && typeof profile.nulls === "object" && !Array.isArray(profile.nulls)
      ? profile.nulls as Record<string, unknown>
      : {};
    const nullCount = numberRecordValue(nulls, "count") ?? 0;
    const nullRatio = numberRecordValue(nulls, "ratio") ?? 0;
    if (nullCount > 0 && nullRatio >= nullRatioThreshold) {
      checks.push({
        rule: "null_values",
        severity: nullRatio >= 0.5 ? "high" : "warn",
        column,
        evidence: [`${nullCount} of ${sampledRows} sampled rows are null.`],
        ratio: nullRatio,
        recommendation: "Confirm whether nulls are valid for this field before using it as a required filter or join key."
      });
    }
    const distinct = profile.distinct && typeof profile.distinct === "object" && !Array.isArray(profile.distinct)
      ? numberRecordValue(profile.distinct as Record<string, unknown>, "value")
      : undefined;
    if (primaryKeySet.has(column.toLowerCase()) && distinct != null && sampledRows > 0 && distinct < sampledRows - nullCount) {
      checks.push({
        rule: "duplicate_key_risk",
        severity: "high",
        column,
        evidence: [`Primary-key-like column has ${distinct} distinct values in ${sampledRows} sampled rows.`],
        recommendation: "Review key uniqueness with a scoped query before relying on this column as a unique identifier."
      });
    }
    if (metadata?.roles.includes("status") && distinct != null && sampledRows > 0 && distinct / sampledRows > 0.8) {
      checks.push({
        rule: "high_cardinality_dimension",
        severity: "warn",
        column,
        evidence: [`Dimension-like column has ${distinct} distinct values in ${sampledRows} sampled rows.`],
        recommendation: "Check whether this field is suitable for grouping, or use a different business dimension."
      });
    }
    if (metadata?.roles.includes("time") && nullRatio > 0.1) {
      checks.push({
        rule: "time_column_nulls",
        severity: "warn",
        column,
        evidence: [`Time-like column null ratio is ${nullRatio}.`],
        recommendation: "Pass an explicit timeColumn when querying recent rows if this field is incomplete."
      });
    }
  }
  return checks;
}

function summarizeDataQualityChecks(checks: Array<Record<string, unknown>>) {
  const high = checks.filter((check) => check.severity === "high").length;
  const warn = checks.filter((check) => check.severity === "warn").length;
  return {
    high,
    warn,
    total: checks.length,
    status: high > 0 ? "attention_required" : warn > 0 ? "review" : "no_sampled_issues"
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
