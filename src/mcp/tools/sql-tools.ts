import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerSqlConversionTools } from "./sql-conversion.js";
import { registerSqlErrorTools } from "./sql-errors.js";
import { registerSqlLintTools } from "./sql-lint.js";
import { registerSqlMapperContextTools } from "./sql-mapper-context.js";
import { registerSqlPrepareTools } from "./sql-prepare.js";
import { registerSqlProjectQueryTools } from "./sql-project-query.js";
import { registerSqlQueryDocTools } from "./sql-query-doc.js";
import { registerSqlRewriteTools } from "./sql-rewrite.js";
import { registerSqlUsageTools } from "./sql-usages.js";
import { registerSqlValidationTools } from "./sql-validation.js";
import { registerSqlUnknownColumnTools } from "./sql-unknown-columns.js";

export function registerSqlTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerSqlConversionTools(registerTool, runtime, context);
  registerSqlErrorTools(registerTool, runtime, context);
  registerSqlLintTools(registerTool, runtime, context);
  registerSqlRewriteTools(registerTool, runtime, context);
  registerSqlUsageTools(registerTool, runtime, context);
  registerSqlValidationTools(registerTool, runtime, context);
  registerSqlProjectQueryTools(registerTool, runtime, context);
  registerSqlQueryDocTools(registerTool, runtime, context);
  registerSqlMapperContextTools(registerTool, runtime, context);
  registerSqlUnknownColumnTools(registerTool, runtime, context);
  registerSqlPrepareTools(registerTool, runtime, context);
}
