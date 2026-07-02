import { z } from "zod";

export const sqlParamSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const buildSelectFilterSchema = z.object({
  column: z.string().min(1),
  operator: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "like", "in", "between", "is_null", "is_not_null"]),
  value: z.union([sqlParamSchema, z.array(sqlParamSchema)]).optional()
});

export const buildSelectOrderBySchema = z.object({
  column: z.string().min(1),
  direction: z.enum(["asc", "desc"]).optional(),
  nulls: z.enum(["first", "last"]).optional()
});

export const resultSummaryColumnSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  table: z.string().optional(),
  schema: z.string().optional(),
  masked: z.boolean().optional()
});

export const compatibilityModeSchema = z.enum(["mysql", "oracle"]);
export const oracleObjectTypeSchema = z.enum(["view", "sequence", "synonym", "procedure", "function", "package", "package_body"]);
export const queryScenarioSchema = z.enum(["by_primary_key", "pagination", "time_range", "aggregation", "join"]);
export const erHtmlFormatSchema = z.enum(["html-static", "html-interactive", "html-compact", "html-detailed"]);
export const erRelationshipModeSchema = z.enum(["none", "foreign_key", "inferred"]);
export const erExportStrategySchema = z.enum(["single", "connected-components", "table-prefix", "business-term", "manual", "window"]);
export const entityDiagramOutputFormatSchema = z.enum(["mermaid", "json", "html"]);
export const erDocumentFormatSchema = z.enum(["markdown", "plantuml", "dot"]);
export const tableDocumentFormatSchema = z.enum(["json", "markdown"]);
export const dataDictionaryFormatSchema = z.enum(["json", "markdown", "html"]);
export const metadataSnapshotInputSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);
export const metadataDiffInputSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);
export const metadataImpactInputSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);
export const sqlUsageIndexInputSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);
export const metadataChangeReportFormatSchema = z.enum(["markdown", "html"]);

export const profileInput = {
  profile: z.string().optional()
};

export type BuildSelectFilter = z.infer<typeof buildSelectFilterSchema>;
export type BuildSelectOrderBy = z.infer<typeof buildSelectOrderBySchema>;
export type ResultSummaryColumn = z.infer<typeof resultSummaryColumnSchema>;
