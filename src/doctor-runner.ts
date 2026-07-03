import "dotenv/config";

import { loadGatewayConfig, loadHttpConfig } from "./config.js";
import { diagnoseGateway, type DiagnosticCheck } from "./diagnostics.js";
import { ping } from "./db.js";
import { jsonText } from "./format.js";
import { diagnoseLocalProject } from "./local-diagnostics.js";
import { closeGatewayRuntime, createGatewayRuntime } from "./runtime.js";

export async function runDoctorCommand(args: string[] = []): Promise<number> {
  const skipConnect = args.includes("--skip-connect");
  try {
    const gatewayConfig = loadGatewayConfig();
    let httpConfig;
    const setupWarnings: DiagnosticCheck[] = [];
    try {
      httpConfig = loadHttpConfig(gatewayConfig.profiles[gatewayConfig.defaultProfile]);
    } catch (error) {
      httpConfig = undefined;
      setupWarnings.push({
        id: "http.config_load",
        severity: "warn",
        message: "HTTP config could not be loaded. This is acceptable for stdio-only local use.",
        remediation: (error as Error).message
      });
    }

    const report = diagnoseGateway(gatewayConfig, httpConfig);
    const localChecks = diagnoseLocalProject(gatewayConfig);
    const connectionChecks = skipConnect ? [{
      id: "local.connection_check",
      severity: "warn" as const,
      message: "OceanBase connection check was skipped.",
      remediation: "Run ob-mcp doctor without --skip-connect before relying on the connection."
    }] : await diagnoseConnections(gatewayConfig);
    const checks = [...report.checks, ...setupWarnings, ...localChecks, ...connectionChecks];
    const output = {
      ...report,
      ok: checks.every((check) => check.severity !== "fail"),
      checks
    };
    console.log(jsonText(output));
    return output.ok ? 0 : 1;
  } catch {
    console.error(
      jsonText({
        ok: false,
        error: {
          message: "Doctor command failed. Review the command arguments and configuration."
        }
      })
    );
    return 1;
  }
}

async function diagnoseConnections(gatewayConfig: ReturnType<typeof loadGatewayConfig>): Promise<DiagnosticCheck[]> {
  const runtime = createGatewayRuntime(gatewayConfig);
  const checks: DiagnosticCheck[] = [];
  try {
    for (const [profileName, config] of Object.entries(gatewayConfig.profiles)) {
      if (!config.password || config.password === "change-me") {
        checks.push({
          id: "local.connection",
          profile: profileName,
          severity: "warn",
          message: "OceanBase connection check was skipped because the password is not configured.",
          remediation: "Set OB_PASSWORD or OB_PASSWORD_FILE, then run doctor again."
        });
        continue;
      }
      try {
        await ping(runtime.pools[profileName], config);
        checks.push({
          id: "local.connection",
          profile: profileName,
          severity: "pass",
          message: "OceanBase connection succeeded."
        });
      } catch {
        checks.push({
          id: "local.connection",
          profile: profileName,
          severity: "fail",
          message: "OceanBase connection failed.",
          remediation: "Check OB_HOST, OB_PORT, OB_USER, OB_PASSWORD, tenant, cluster, network, and compatibility mode."
        });
      }
    }
  } finally {
    await closeGatewayRuntime(runtime);
  }
  return checks;
}
