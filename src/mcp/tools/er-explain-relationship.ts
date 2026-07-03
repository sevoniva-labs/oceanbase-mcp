import { z } from "zod";

import { findRelatedTables } from "../../db.js";
import { assertTableAccess } from "../../policy.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import { profileInput } from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";
import {
  dedupeRelationships,
  entityRelationshipEvidence,
  isErRelationshipVisible,
  parseErInputTableRef,
  relationshipConnectsTables,
  relationshipPaths
} from "./er-relationships.js";

export function registerErExplainRelationshipTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_explain_relationship",
    {
      title: "Explain Table Relationship",
      description: "Explain visible relationship evidence between two OceanBase tables without inventing missing relationships.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        sourceSchema: z.string().optional(),
        sourceTable: z.string().min(1),
        targetSchema: z.string().optional(),
        targetTable: z.string().min(1),
        depth: z.number().int().min(1).max(3).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        includeInferred: z.boolean().optional().default(true)
      }
    },
    async ({ profile, schema, sourceSchema, sourceTable, targetSchema, targetTable, depth, minConfidence, includeInferred = true }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const fallbackSchema = metadataSchema(selected.config, schema);
      const sourceRef = parseErInputTableRef(selected.config.compatibility, sourceTable, metadataSchema(selected.config, sourceSchema) ?? fallbackSchema);
      const targetRef = parseErInputTableRef(selected.config.compatibility, targetTable, metadataSchema(selected.config, targetSchema) ?? fallbackSchema);
      assertTableAccess(sourceRef.schema, sourceRef.table, policyContext(selected.config));
      assertTableAccess(targetRef.schema, targetRef.table, policyContext(selected.config));
      const depthLimit = depth ?? 2;
      const confidenceFloor = minConfidence ?? (includeInferred ? 0.5 : 0.9);
      const result = await withQuerySlot(selected, () =>
        findRelatedTables(
          selected.pool,
          selected.config.compatibility,
          sourceRef.table,
          sourceRef.schema,
          depthLimit,
          100,
          selected.config.queryTimeoutMs
        )
      );
      const visibleRelations = dedupeRelationships(selected.config.compatibility, result.relations)
        .filter((relation) => isErRelationshipVisible(relation, selected.config, confidenceFloor, includeInferred));
      const matches = visibleRelations
        .filter((relation) => relationshipConnectsTables(selected.config.compatibility, relation, sourceRef, targetRef))
        .map(entityRelationshipEvidence);
      const paths = relationshipPaths(
        selected.config.compatibility,
        visibleRelations,
        sourceRef,
        targetRef,
        depthLimit,
        10
      );

      return toLimitedResult(
        {
          mode: selected.config.compatibility,
          source: sourceRef,
          target: targetRef,
          depth: depthLimit,
          minConfidence: confidenceFloor,
          includeInferred,
          conclusion: matches.length > 0 || paths.length > 0 ? "relationship_found" : "not_found",
          relationshipCount: matches.length,
          pathCount: paths.length,
          relationships: matches,
          paths,
          warnings: matches.length > 0 || paths.length > 0
            ? []
            : ["No visible relationship was found between the two tables under the active policy and confidence settings."]
        },
        selected.config
      );
    }
  );
}
