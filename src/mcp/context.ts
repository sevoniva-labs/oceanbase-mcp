import type { AuthPrincipal } from "../config.js";

export interface McpRequestContext {
  principal?: AuthPrincipal;
  requestId?: string;
  clientId?: string;
  transport?: "stdio" | "http";
}
