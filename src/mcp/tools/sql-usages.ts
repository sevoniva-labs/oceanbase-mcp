import { z } from "zod";

import { findSqlUsages } from "../../sql-usage.js";
import type { GatewayRuntime } from "../../runtime.js";
import { selectAuthorizedProfile } from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataSchema } from "../metadata-scope.js";
import {
  profileInput,
  sqlUsageIndexInputSchema
} from "../schemas.js";
import { toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerSqlUsageTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerTool(
    "ob_find_sql_usages",
    {
      title: "Find SQL Usages",
      description: "Find project SQL usages from a static SQL usage index without executing SQL or reading project files.",
      inputSchema: {
        ...profileInput,
        sqlIndex: sqlUsageIndexInputSchema,
        schema: z.string().optional(),
        table: z.string().optional(),
        column: z.string().optional(),
        businessTerm: z.string().optional(),
        maxResults: z.number().int().positive().max(200).optional()
      }
    },
    async ({ profile, sqlIndex, schema, table, column, businessTerm, maxResults }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = findSqlUsages(sqlIndex, {
        schema: metadataSchema(selected.config, schema),
        table,
        column,
        businessTerm,
        maxResults
      });
      return toLimitedResult(result, selected.config);
    }
  );
}
