import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

checkWorkflowActionPins();
checkWorkflowPermissions();
checkDockerBaseImage();
checkPackageScope();
checkNoReleaseDocsInNpmPackage();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log("security gates passed");

function checkWorkflowActionPins() {
  for (const file of listFiles(path.join(root, ".github", "workflows"), [".yml", ".yaml"])) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = /^\s*uses:\s*([^@\s]+)@([^\s#]+)/.exec(line);
      if (!match) {
        return;
      }
      const ref = match[2];
      if (!/^[0-9a-f]{40}$/i.test(ref)) {
        failures.push(`${rel(file)}:${index + 1}: GitHub Action must be pinned to a full commit SHA`);
      }
    });
  }
}

function checkWorkflowPermissions() {
  for (const file of listFiles(path.join(root, ".github", "workflows"), [".yml", ".yaml"])) {
    const content = fs.readFileSync(file, "utf8");
    if (!/^permissions:\n/m.test(content)) {
      failures.push(`${rel(file)}: workflow must define explicit top-level permissions`);
    }
  }
}

function checkDockerBaseImage() {
  const dockerfile = path.join(root, "Dockerfile");
  if (!fs.existsSync(dockerfile)) {
    failures.push("Dockerfile is missing");
    return;
  }
  const lines = fs.readFileSync(dockerfile, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/^\s*FROM\s+/i.test(line) && !/@sha256:[a-f0-9]{64}\b/i.test(line)) {
      failures.push(`Dockerfile:${index + 1}: base image must be pinned by sha256 digest`);
    }
  }
}

function checkPackageScope() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const files = packageJson.files ?? [];
  for (const disallowed of ["scripts", "docs", "test", "node_modules", "tmp", "output"]) {
    if (files.includes(disallowed)) {
      failures.push(`package.json: files must not include ${disallowed}`);
    }
  }
  for (const required of ["dist", "docs/en", "docs/zh-CN", "deploy", "examples", ".opencode", "README.md", ".env.example", "Dockerfile", "docker-compose.yml"]) {
    if (!files.includes(required)) {
      failures.push(`package.json: files must include ${required}`);
    }
  }
}

function checkNoReleaseDocsInNpmPackage() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const files = packageJson.files ?? [];
  if (files.some((entry) => /^docs\/release-v/.test(entry))) {
    failures.push("package.json: release history documents must not be included in npm package files");
  }
}

function listFiles(dir, extensions) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...listFiles(fullPath, extensions));
      continue;
    }
    if (extensions.includes(path.extname(entry.name))) {
      output.push(fullPath);
    }
  }
  return output;
}

function rel(file) {
  return path.relative(root, file);
}
