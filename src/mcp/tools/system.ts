import { z } from "zod";

import {
  buildUsageGuide,
  listCapabilities,
  TOOL_CAPABILITIES
} from "../../capabilities.js";
import type { HttpConfig } from "../../config.js";
import { ping, verifyReadOnlyPermissions, type SqlParam } from "../../db.js";
import { diagnoseGateway } from "../../diagnostics.js";
import { diagnoseOpenCodeSetup } from "../../local-diagnostics.js";
import {
  assertTableAccess,
  explainSqlPolicy,
  isSchemaAllowed
} from "../../policy.js";
import { withQuerySlot, type GatewayRuntime } from "../../runtime.js";
import { assertReadOnlySql, assertSqlInputLimits } from "../../sql.js";
import {
  authorizedGatewayConfig,
  isToolAllowed,
  publicProfiles,
  selectAuthorizedProfile,
  visibleDefaultProfile
} from "../access.js";
import type { McpRequestContext } from "../context.js";
import { metadataCacheStatus, refreshMetadataCache } from "../metadata-cache.js";
import { metadataSchema } from "../metadata-scope.js";
import { policyContext } from "../policy-context.js";
import {
  profileInput,
  sqlParamSchema
} from "../schemas.js";
import { runExplainCheck } from "../sql-policy-explain.js";
import { toGatewayLimitedResult, toLimitedResult } from "../tool-runtime.js";
import type { ToolRegistrar } from "../tool-registry.js";

export function registerSystemTools(
  registerTool: ToolRegistrar,
  runtime: GatewayRuntime,
  context: McpRequestContext,
  httpConfig?: HttpConfig
): void {
  registerTool(
    "ob_list_profiles",
    {
      title: "List OceanBase Profiles",
      description: "List configured OceanBase MCP profiles with redacted settings.",
      inputSchema: {}
    },
    async () =>
      toGatewayLimitedResult({
        defaultProfile: visibleDefaultProfile(runtime, context),
        profiles: publicProfiles(runtime, context)
      }, runtime, context)
  );

  registerTool(
    "ob_config_diagnostics",
    {
      title: "Run Config Diagnostics",
      description: "Check profile, policy, TLS, HTTP, and production hardening settings.",
      inputSchema: {}
    },
    async () =>
      toGatewayLimitedResult(
        diagnoseGateway(authorizedGatewayConfig(runtime, context), httpConfig),
        runtime,
        context
      )
  );

  registerTool(
    "ob_check_opencode_setup",
    {
      title: "Check OpenCode Setup",
      description: "Check local OpenCode config, OceanBase agent, and query skill files for the current project.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      return toLimitedResult(
        diagnoseOpenCodeSetup(authorizedGatewayConfig(runtime, context)),
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_usage_guide",
    {
      title: "Get OceanBase MCP Usage Guide",
      description: "Return the recommended read-only OpenCode workflow, safety rules, and MySQL/Oracle notes.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      return toLimitedResult(
        buildUsageGuide({
          profile: selected.profile,
          compatibility: selected.config.compatibility
        }),
        selected.config
      );
    }
  );

  registerTool(
    "ob_list_capabilities",
    {
      title: "List OceanBase MCP Capabilities",
      description: "List supported tool groups, tool versions, active compatibility mode, and read-only limits.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const visibleTools = TOOL_CAPABILITIES.filter((tool) => isToolAllowed(tool.name, context.principal));
      return toLimitedResult(
        listCapabilities({
          profile: selected.profile,
          compatibility: selected.config.compatibility,
          tools: visibleTools
        }),
        selected.config
      );
    }
  );

  registerTool(
    "ob_refresh_metadata_cache",
    {
      title: "Refresh Metadata Cache",
      description: "Clear in-memory metadata cache entries for the active profile, optionally scoped by schema or table.",
      inputSchema: {
        ...profileInput,
        schema: z.string().optional(),
        table: z.string().optional()
      }
    },
    async ({ profile, schema, table }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const effectiveSchema = metadataSchema(selected.config, schema);
      if (effectiveSchema && !isSchemaAllowed(effectiveSchema, selected.config.policy)) {
        throw new Error(`Schema "${effectiveSchema}" is not allowed by the configured OceanBase MCP access policy.`);
      }
      if (table) {
        assertTableAccess(effectiveSchema, table, policyContext(selected.config));
      }
      return toLimitedResult(
        refreshMetadataCache(selected, effectiveSchema, table),
        selected.config
      );
    }
  );

  registerTool(
    "ob_get_cache_status",
    {
      title: "Get Metadata Cache Status",
      description: "Return profile-scoped metadata cache settings and counters without exposing cached content.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      return toLimitedResult(
        metadataCacheStatus(selected),
        selected.config
      );
    }
  );

  registerTool(
    "ob_verify_permissions",
    {
      title: "Verify Database Permissions",
      description: "Inspect current database grants and report whether the account appears read-only.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await withQuerySlot(selected, () =>
        verifyReadOnlyPermissions(selected.pool, selected.config.compatibility, selected.config.queryTimeoutMs)
      );
      return toLimitedResult(
        {
          profile: selected.profile,
          ...result
        },
        selected.config
      );
    }
  );

  registerTool(
    "ob_ping",
    {
      title: "Ping OceanBase",
      description: "Verify the configured OceanBase connection.",
      inputSchema: profileInput
    },
    async ({ profile }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const result = await withQuerySlot(selected, () => ping(selected.pool, selected.config));
      return toLimitedResult(result, selected.config);
    }
  );

  registerTool(
    "ob_policy_explain",
    {
      title: "Explain SQL Policy Decision",
      description: "Explain whether a SQL statement is allowed and which read-only or access-policy checks apply.",
      inputSchema: {
        ...profileInput,
        sql: z.string().min(1),
        params: z.array(sqlParamSchema).optional().default([])
      }
    },
    async ({ profile, sql, params = [] }) => {
      const selected = selectAuthorizedProfile(runtime, profile, context);
      const sqlParams = params as SqlParam[];
      const checks = [
        runExplainCheck("input_limits", () => assertSqlInputLimits(sql, sqlParams, selected.config)),
        runExplainCheck("read_only_sql", () => assertReadOnlySql(sql))
      ];
      const policy = explainSqlPolicy(sql, policyContext(selected.config));
      return toLimitedResult({
        profile: selected.profile,
        allowed: checks.every((check) => check.ok) && policy.allowed,
        checks,
        policy
      }, selected.config);
    }
  );
}
