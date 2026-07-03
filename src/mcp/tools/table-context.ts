import { z } from "zod";

import {
  findRelatedTables,
  getTableDdlMetadata,
  getTableStats,
  renderStructuredTableDdl,
  sampleRows,
  type TableRelationship
} from "../../db.js";
import type { QueryOutput } from "../../format.js";
import {
  assertOutputAllowed,
  assertTableAccess,
  filterColumnMetadata,
  filterTables
} from "../../policy.js";
import { effectiveRowLimit, maskOutput } from "../../query/output.js";
import { generateQueryTemplates } from "../../query-generation.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { explainGeneratedQuery } from "../sql-policy-explain.js";
import { toLimitedResult } from "../tool-runtime.js";
import { DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT } from "./catalog.js";
import { isRelationshipAllowed } from "./schema-map.js";
import type { ToolRegistrar } from "../tool-registry.js";

const LARGE_TABLE_CONTEXT_SAMPLE_ROW_THRESHOLD = 100_000;

export function registerTableContextTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_get_table_context",
    {
      title: "Get Table Context",
      description: "Return the common read-only table context needed for SQL drafting and data inspection.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        includeSample: z.boolean().optional().default(true),
        includeRelated: z.boolean().optional().default(true),
        includeTemplates: z.boolean().optional().default(true),
        sampleLimit: z.number().int().positive().max(20).optional(),
        relationshipLimit: z.number().int().positive().max(100).optional(),
        maxTemplateColumns: z.number().int().min(1).max(50).optional()
      }
    },
    async ({
      profile,
      table,
      schema,
      includeSample = true,
      includeRelated = true,
      includeTemplates = true,
      sampleLimit,
      relationshipLimit,
      maxTemplateColumns
    }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      assertTableAccess(effectiveSchema, table, policyContext(selected.config));

      const metadata = await withQuerySlot(selected, () =>
        getTableDdlMetadata(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs, DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT)
      );
      const columns = filterColumnMetadata(metadata.columns, selected.config.policy);
      const indexes = filterColumnMetadata(metadata.indexes, selected.config.policy);
      const constraints = filterColumnMetadata(metadata.constraints, selected.config.policy);
      const partitions = filterTables(metadata.partitions, selected.config.policy);
      const policyFiltered =
        columns.length !== metadata.columns.length ||
        indexes.length !== metadata.indexes.length ||
        constraints.length !== metadata.constraints.length ||
        partitions.length !== metadata.partitions.length;
      const ddl =
        metadata.nativeDdl && !policyFiltered
          ? metadata.nativeDdl
          : renderStructuredTableDdl(selected.config.compatibility, metadata.schema, metadata.table, columns, indexes, constraints, partitions);
      const warnings = [...metadata.warnings];
      if (policyFiltered) {
        warnings.push("Some metadata rows were hidden by policy.");
      }
      if (metadata.columnsTruncated) {
        warnings.push(`Column metadata was limited to ${DESCRIBE_TABLE_DEFAULT_COLUMN_LIMIT} column(s) for table context.`);
      }

      const statistics = await withQuerySlot(selected, () =>
        getTableStats(selected.pool, selected.config.compatibility, table, effectiveSchema, selected.config.queryTimeoutMs)
      );

      let relatedTables: { relations: TableRelationship[]; policyFiltered: boolean } | undefined;
      let relationships: TableRelationship[] = [];
      if (includeRelated) {
        const result = await withQuerySlot(selected, () =>
          findRelatedTables(
            selected.pool,
            selected.config.compatibility,
            table,
            effectiveSchema,
            1,
            Math.min(relationshipLimit ?? 20, 100),
            selected.config.queryTimeoutMs
          )
        );
        relationships = result.relations.filter((relation) => isRelationshipAllowed(relation, selected.config));
        relatedTables = {
          relations: relationships,
          policyFiltered: relationships.length !== result.relations.length
        };
      }

      let queryTemplates:
        | {
            templates: ReturnType<typeof generateQueryTemplates>["templates"];
            warnings: string[];
            executed: false;
          }
        | undefined;
      if (includeTemplates) {
        const generated = generateQueryTemplates({
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          columns,
          constraints,
          relationships,
          maxColumns: maxTemplateColumns ?? 12,
          rowLimit: effectiveRowLimit(undefined, selected.config)
        });
        queryTemplates = {
          templates: generated.templates.map((template) => ({
            ...template,
            policy: explainGeneratedQuery(template.sql, template.parameters.length, selected.config)
          })),
          warnings: generated.warnings,
          executed: false
        };
      }

      let sample: QueryOutput | undefined;
      if (includeSample) {
        const rowEstimate = statistics.rowEstimate?.value;
        const skipLargeTableSample =
          sampleLimit == null &&
          rowEstimate != null &&
          rowEstimate >= LARGE_TABLE_CONTEXT_SAMPLE_ROW_THRESHOLD;
        if (skipLargeTableSample) {
          warnings.push(
            `Sample rows were skipped because the table row estimate is ${rowEstimate}. Pass sampleLimit explicitly to request a bounded sample.`
          );
        } else {
          const sampleColumns = safeSampleColumnNames(columns).slice(0, 50);
          const skippedLargeColumns = columnNames(columns).filter((column) => !sampleColumns.includes(column));
          if (skippedLargeColumns.length > 0) {
            warnings.push(`Sample rows skipped large or binary columns: ${skippedLargeColumns.slice(0, 10).join(", ")}${skippedLargeColumns.length > 10 ? ", ..." : ""}.`);
          }
          if (sampleColumns.length === 0) {
            warnings.push("Sample rows were skipped because no visible columns are available.");
          } else {
            const output = await withQuerySlot(selected, () =>
              sampleRows(
                selected.pool,
                selected.config.compatibility,
                effectiveSchema,
                table,
                sampleColumns,
                Math.min(sampleLimit ?? 3, selected.config.maxRows, 20),
                selected.config.queryTimeoutMs,
                selected.config.maxResultBytes
              )
            );
            assertOutputAllowed(output, selected.config.policy);
            sample = maskOutput(output, selected.config, effectiveSchema, table);
          }
        }
      }

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: metadata.schema,
          table: metadata.table,
          ddl: {
            source: metadata.nativeDdl && !policyFiltered ? "native" : "structured",
            policyFiltered,
            text: ddl
          },
          columns,
          indexes,
          constraints,
          partitions,
          statistics,
          relatedTables,
          queryTemplates,
          sample,
          warnings
        },
        selected.config
      );
    }
  );
}

function columnNames(rows: unknown[]): string[] {
  return rows
    .map((row) => row as Record<string, unknown>)
    .map((row) => String(row.column_name ?? row.COLUMN_NAME ?? row.name ?? row.NAME ?? ""))
    .filter(Boolean);
}

function safeSampleColumnNames(rows: unknown[]): string[] {
  return rows
    .map((row) => row as Record<string, unknown>)
    .filter((row) => {
      const type = String(row.data_type ?? row.DATA_TYPE ?? row.type ?? row.TYPE ?? "").toLowerCase();
      return !/(blob|clob|text|json|geometry|binary|raw|long)/.test(type);
    })
    .map((row) => String(row.column_name ?? row.COLUMN_NAME ?? row.name ?? row.NAME ?? ""))
    .filter(Boolean);
}
