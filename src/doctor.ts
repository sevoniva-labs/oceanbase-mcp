#!/usr/bin/env node
import "dotenv/config";

import { loadGatewayConfig, loadHttpConfig } from "./config.js";
import { diagnoseGateway } from "./diagnostics.js";
import { jsonText } from "./format.js";

try {
  const gatewayConfig = loadGatewayConfig();
  let httpConfig;
  try {
    httpConfig = loadHttpConfig(gatewayConfig.profiles[gatewayConfig.defaultProfile]);
  } catch (error) {
    httpConfig = undefined;
    console.error(
      jsonText({
        level: "warn",
        message: "HTTP config could not be loaded. This is acceptable for stdio-only deployments.",
        error: (error as Error).message
      })
    );
  }
  const report = diagnoseGateway(gatewayConfig, httpConfig);
  console.log(jsonText(report));
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(
    jsonText({
      ok: false,
      error: {
        message: (error as Error).message,
        name: (error as Error).name
      }
    })
  );
  process.exit(1);
}
