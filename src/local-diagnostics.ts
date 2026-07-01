import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DiagnosticCheck } from "./diagnostics.js";
import type { GatewayConfig } from "./config.js";

export interface LocalDiagnosticOptions {
  cwd?: string;
  nodeVersion?: string;
}

export function diagnoseLocalProject(config: GatewayConfig, options: LocalDiagnosticOptions = {}): DiagnosticCheck[] {
  const cwd = options.cwd ?? process.cwd();
  const checks: DiagnosticCheck[] = [];
  checks.push(checkNodeVersion(options.nodeVersion ?? process.version));
  checks.push(fileCheck(cwd, "local.package_json", "package.json", "package.json is present.", "Run doctor from the ob-mcp project or generated local project directory."));
  checks.push(fileCheck(cwd, "local.node_modules", "node_modules", "node_modules is present.", "Run npm ci before starting the local server."));
  checks.push(fileCheck(cwd, "local.dist_index", join("dist", "index.js"), "dist/index.js is present.", "Run npm run build before starting OpenCode."));
  checks.push(fileCheck(cwd, "local.env", ".env", ".env is present.", "Run ob-mcp init or copy .env.example to .env, then set local connection values."));
  checks.push(...opencodeChecks(cwd));
  checks.push(...profileLocalChecks(config));
  return checks;
}

function checkNodeVersion(version: string): DiagnosticCheck {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return {
    id: "local.node_version",
    severity: major >= 20 ? "pass" : "fail",
    message: major >= 20 ? `Node.js ${version} is supported.` : `Node.js ${version} is not supported.`,
    remediation: "Install Node.js 20 or newer."
  };
}

function fileCheck(cwd: string, id: string, relativePath: string, okMessage: string, remediation: string): DiagnosticCheck {
  const path = join(cwd, relativePath);
  return {
    id,
    severity: existsSync(path) ? "pass" : "warn",
    message: existsSync(path) ? okMessage : `${relativePath} is missing.`,
    remediation
  };
}

function opencodeChecks(cwd: string): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const configPath = join(cwd, "opencode.jsonc");
  const hasConfig = existsSync(configPath);
  checks.push({
    id: "local.opencode_config",
    severity: hasConfig ? "pass" : "warn",
    message: hasConfig ? "OpenCode config is present." : "opencode.jsonc is missing.",
    remediation: "Run ob-mcp init or copy an OpenCode example from examples/."
  });
  if (hasConfig) {
    const content = readFileSync(configPath, "utf8");
    checks.push({
      id: "local.opencode_mcp",
      severity: /"oceanbase"\s*:/.test(content) && /"mcp"\s*:/.test(content) ? "pass" : "warn",
      message: /"oceanbase"\s*:/.test(content) && /"mcp"\s*:/.test(content)
        ? "OpenCode config contains an oceanbase MCP entry."
        : "OpenCode config does not appear to contain an oceanbase MCP entry.",
      remediation: "Add the oceanbase MCP entry from docs or run ob-mcp init."
    });
  }
  checks.push(fileCheck(cwd, "local.opencode_agent", join(".opencode", "agents", "oceanbase-developer.md"), "OpenCode OceanBase agent is present.", "Run ob-mcp init to generate the OpenCode agent."));
  checks.push(fileCheck(cwd, "local.opencode_skill", join(".opencode", "skills", "oceanbase-query", "SKILL.md"), "OpenCode OceanBase query skill is present.", "Run ob-mcp init to generate the OpenCode skill."));
  return checks;
}

function profileLocalChecks(config: GatewayConfig): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  for (const profile of Object.values(config.profiles)) {
    checks.push({
      id: "local.compatibility_mode",
      profile: profile.profile,
      severity: profile.compatibility === "mysql" || profile.compatibility === "oracle" ? "pass" : "fail",
      message: `OceanBase compatibility mode is ${profile.compatibility}.`
    });
    checks.push({
      id: "local.placeholder_password",
      profile: profile.profile,
      severity: profile.password === "change-me" ? "warn" : "pass",
      message: profile.password === "change-me" ? "OB_PASSWORD still uses the init placeholder." : "OB_PASSWORD is not the init placeholder.",
      remediation: "Set OB_PASSWORD or OB_PASSWORD_FILE before running queries."
    });
    checks.push({
      id: "local.masking_policy",
      profile: profile.profile,
      severity: profile.policy.maskedColumns.length > 0 ? "pass" : "warn",
      message: profile.policy.maskedColumns.length > 0
        ? "Field-level masking rules are configured."
        : "No field-level masking rules are configured.",
      remediation: "Set OB_MASKED_COLUMNS when sample output may include sensitive business fields."
    });
    checks.push({
      id: "local.business_glossary",
      profile: profile.profile,
      severity: profile.businessGlossary ? "pass" : "warn",
      message: profile.businessGlossary
        ? `Business glossary is configured with ${profile.businessGlossary.entries.length} terms.`
        : "Business glossary is not configured.",
      remediation: "Set OB_BUSINESS_GLOSSARY_FILE to improve business-term search."
    });
  }
  return checks;
}
