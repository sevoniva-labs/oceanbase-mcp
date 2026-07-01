import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadGatewayConfig } from "../dist/config.js";
import { diagnoseLocalProject } from "../dist/local-diagnostics.js";

test("diagnoseLocalProject reports local setup checks without secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-local-diag-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sample" }));
    writeFileSync(join(dir, ".env"), "OB_PASSWORD=change-me\n");
    writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify({ mcp: { oceanbase: { type: "local" } } }));
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "");
    mkdirSync(join(dir, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "agents", "oceanbase-developer.md"), "");
    mkdirSync(join(dir, ".opencode", "skills", "oceanbase-query"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "skills", "oceanbase-query", "SKILL.md"), "");

    const gateway = loadGatewayConfig({
      OB_USER: "u@t#c",
      OB_PASSWORD: "change-me",
      OB_ALLOWED_SCHEMAS: "app",
      OB_COMPATIBILITY: "mysql"
    });
    const checks = diagnoseLocalProject(gateway, { cwd: dir, nodeVersion: "v22.0.0" });

    assert(checks.some((check) => check.id === "local.node_version" && check.severity === "pass"));
    assert(checks.some((check) => check.id === "local.opencode_mcp" && check.severity === "pass"));
    assert(checks.some((check) => check.id === "local.placeholder_password" && check.severity === "warn"));
    assert(checks.some((check) => check.id === "local.business_glossary" && check.severity === "warn"));
    assert.equal(JSON.stringify(checks).includes("change-me"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnoseLocalProject fails unsupported Node versions", () => {
  const gateway = loadGatewayConfig({ OB_USER: "u@t#c", OB_PASSWORD: "secret", OB_ALLOWED_SCHEMAS: "app" });
  const checks = diagnoseLocalProject(gateway, { cwd: tmpdir(), nodeVersion: "v18.19.0" });
  assert(checks.some((check) => check.id === "local.node_version" && check.severity === "fail"));
});
