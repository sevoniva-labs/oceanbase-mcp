import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createInitPlan, parseInitArgs, writeInitFiles } from "../dist/init.js";

test("createInitPlan creates local mysql files without real secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-init-"));
  try {
    const plan = createInitPlan({ cwd: dir, mode: "mysql", schema: "app", host: "obproxy.local" });
    assert.equal(plan.mode, "mysql");
    assert.deepEqual(plan.files.map((file) => file.path.replace(`${dir}/`, "")).sort(), [
      ".env",
      ".opencode/agents/oceanbase-developer.md",
      ".opencode/skills/oceanbase-query/SKILL.md",
      "business-glossary.json",
      "opencode.jsonc"
    ]);

    const env = plan.files.find((file) => file.path.endsWith(".env")).content;
    assert.match(env, /OB_HOST=obproxy\.local/);
    assert.match(env, /OB_COMPATIBILITY=mysql/);
    assert.match(env, /OB_ALLOWED_SCHEMAS=app/);
    assert.match(env, /OB_PASSWORD=change-me/);
    assert.doesNotMatch(env, /ob_password/);

    const opencode = JSON.parse(plan.files.find((file) => file.path.endsWith("opencode.jsonc")).content);
    assert.deepEqual(opencode.mcp.oceanbase.command, ["ob-mcp"]);
    assert.equal(opencode.mcp.oceanbase.environment.OB_BUSINESS_GLOSSARY_FILE, "business-glossary.json");

    const agent = plan.files.find((file) => file.path.endsWith(".opencode/agents/oceanbase-developer.md")).content;
    const skill = plan.files.find((file) => file.path.endsWith(".opencode/skills/oceanbase-query/SKILL.md")).content;
    assert.match(agent, /ob_prepare_query/);
    assert.match(agent, /ob_generate_er_html/);
    assert.match(skill, /ob_build_select/);
    assert.match(skill, /ob_start_query_session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createInitPlan uses oracle defaults when requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-init-"));
  try {
    const plan = createInitPlan({ cwd: dir, mode: "oracle" });
    const env = plan.files.find((file) => file.path.endsWith(".env")).content;
    assert.match(env, /OB_USER=ob_user@ob_oracle#obcluster/);
    assert.match(env, /OB_COMPATIBILITY=oracle/);
    assert.match(env, /OB_ALLOWED_SCHEMAS=OB_USER/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeInitFiles refuses to overwrite unless force is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-init-"));
  try {
    const plan = createInitPlan({ cwd: dir });
    const written = writeInitFiles(plan);
    assert.equal(written.length, 5);
    assert.equal(existsSync(join(dir, ".opencode", "skills", "oceanbase-query", "SKILL.md")), true);
    assert.throws(() => writeInitFiles(plan), /already exists/);

    writeFileSync(join(dir, ".env"), "stale=true\n");
    writeInitFiles(plan, { force: true });
    assert.match(readFileSync(join(dir, ".env"), "utf8"), /OB_MCP_READ_ONLY=true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseInitArgs parses supported options", () => {
  assert.deepEqual(parseInitArgs([
    "--mode", "oracle",
    "--host=127.0.0.2",
    "--port", "2884",
    "--schema", "APP",
    "--username", "app",
    "--tenant", "ob_oracle",
    "--cluster", "obcluster",
    "--dry-run",
    "--force"
  ]), {
    mode: "oracle",
    host: "127.0.0.2",
    port: "2884",
    schema: "APP",
    username: "app",
    tenant: "ob_oracle",
    cluster: "obcluster",
    dryRun: true,
    force: true
  });
  assert.throws(() => parseInitArgs(["--mode", "postgres"]), /mysql or oracle/);
});
