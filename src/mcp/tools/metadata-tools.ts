import type { GatewayRuntime } from "../../runtime.js";
import type { McpRequestContext } from "../context.js";
import type { ToolRegistrar } from "../tool-registry.js";
import { registerCatalogTools } from "./catalog.js";
import { registerColumnDetectionTools } from "./column-detection.js";
import { registerObjectMetadataTools } from "./object-metadata.js";
import { registerSchemaMapTools } from "./schema-map.js";
import { registerSearchCatalogTools } from "./search-catalog.js";
import { registerTableContextTools } from "./table-context.js";
import { registerTableMetadataTools } from "./table-metadata.js";

export function registerMetadataTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext
): void {
  registerCatalogTools(registerTool, runtime, context);
  registerSchemaMapTools(registerTool, runtime, context);
  registerSearchCatalogTools(registerTool, runtime, context);
  registerTableMetadataTools(registerTool, runtime, context);
  registerTableContextTools(registerTool, runtime, context);
  registerObjectMetadataTools(registerTool, runtime, context);
  registerColumnDetectionTools(registerTool, runtime, context);
}
