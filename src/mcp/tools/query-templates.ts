import { z } from "zod";

import {
  describeTable,
  findRelatedTables,
  listConstraints
} from "../../db.js";
import {
  assertTableAccess,
  filterColumnMetadata,
  isDeniedColumn
} from "../../policy.js";
import { effectiveRowLimit } from "../../query/output.js";
import { generateQueryTemplates, type QueryTemplateScenario } from "../../query-generation.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { queryExampleFromTemplate } from "../query-examples.js";
import {
  profileInput,
  queryScenarioSchema
} from "../schemas.js";
import { explainGeneratedQuery } from "../sql-policy-explain.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { isRelationshipAllowed } from "./schema-map.js";

export function registerQueryTemplateTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_generate_query",
    {
      title: "Generate Read-only Query Templates",
      description: "Generate read-only SQL templates from policy-filtered table metadata without executing them.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        scenarios: z.array(queryScenarioSchema).optional(),
        maxColumns: z.number().int().min(1).max(50).optional(),
        maxRows: z.number().int().positive().optional()
      }
    },
    async ({ profile, table, schema, scenarios, maxColumns, maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      const requestedScenarios = scenarios as QueryTemplateScenario[] | undefined;
      const templateContext = await loadQueryTemplateContext(selected, effectiveSchema, table, requestedScenarios);
      const generated = generateQueryTemplates({
        ...templateContext,
        scenarios: requestedScenarios,
        maxColumns: maxColumns ?? 12,
        rowLimit: effectiveRowLimit(maxRows, selected.config)
      });
      const templates = generated.templates.map((template) => ({
        ...template,
        policy: explainGeneratedQuery(template.sql, template.parameters.length, selected.config)
      }));
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          templates,
          warnings: generated.warnings,
          executed: false
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_generate_query_examples",
    {
      title: "Generate Query Examples",
      description: "Generate scenario-based read-only SQL examples from policy-filtered table metadata without executing them.",
      inputSchema: {
        ...profileInput,
        table: z.string().min(1),
        schema: z.string().optional(),
        scenarios: z.array(queryScenarioSchema).optional(),
        maxColumns: z.number().int().min(1).max(50).optional(),
        maxRows: z.number().int().positive().optional()
      }
    },
    async ({ profile, table, schema, scenarios, maxColumns, maxRows }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      const requestedScenarios = scenarios as QueryTemplateScenario[] | undefined;
      const templateContext = await loadQueryTemplateContext(selected, effectiveSchema, table, requestedScenarios);
      const rowLimit = effectiveRowLimit(maxRows, selected.config);
      const generated = generateQueryTemplates({
        ...templateContext,
        scenarios: requestedScenarios,
        maxColumns: maxColumns ?? 12,
        rowLimit
      });
      const examples = generated.templates.map((template) =>
        queryExampleFromTemplate(template, selected.config)
      );
      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          schema: effectiveSchema,
          table,
          rowLimit,
          examples,
          warnings: generated.warnings,
          executed: false
        },
        selected.config
      );
    }
  );
}

async function loadQueryTemplateContext(
  selected: ReturnType<typeof selectAuthorizedProfile>,
  schema: string | undefined,
  table: string,
  scenarios: QueryTemplateScenario[] | undefined
) {
  assertTableAccess(schema, table, policyContext(selected.config));
  const columns = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      describeTable(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const constraints = filterColumnMetadata(
    await withQuerySlot(selected, () =>
      listConstraints(selected.pool, selected.config.compatibility, table, schema, selected.config.queryTimeoutMs)
    ),
    selected.config.policy
  );
  const relationships = !scenarios || scenarios.includes("join")
    ? (await withQuerySlot(selected, () =>
        findRelatedTables(selected.pool, selected.config.compatibility, table, schema, 1, 20, selected.config.queryTimeoutMs)
      )).relations.filter((relation) =>
        isRelationshipAllowed(relation, selected.config) &&
        relation.sourceColumns.every((column) => !isDeniedColumn(column, selected.config.policy)) &&
        relation.targetColumns.every((column) => !isDeniedColumn(column, selected.config.policy))
      )
    : [];

  return {
    mode: selected.config.compatibility,
    schema,
    table,
    columns,
    constraints,
    relationships
  };
}
