import fs from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);

if (roots.length === 0) {
  console.error("usage: node scripts/check-doc-links.mjs <file-or-directory>...");
  process.exit(2);
}

const markdownFiles = [];

function walk(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      walk(path.join(target, entry));
    }
    return;
  }
  if (target.endsWith(".md")) {
    markdownFiles.push(target);
  }
}

for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.error(`missing root: ${root}`);
    process.exit(1);
  }
  walk(root);
}

const failures = [];
const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const toolHeadings = new Set(["## Tools / 工具", "## Tools", "## 工具列表"]);
const bannedPublicPhrases = [
  { phrase: "内网", reason: "use a neutral public deployment term" },
  { phrase: "私有制品库", reason: "use npm registry mirror wording" },
  { phrase: "私有网络", reason: "use trusted network wording" }
];

for (const file of markdownFiles) {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  for (const match of content.matchAll(markdownLink)) {
    const rawTarget = match[1];
    if (
      rawTarget.startsWith("http://") ||
      rawTarget.startsWith("https://") ||
      rawTarget.startsWith("mailto:") ||
      rawTarget.startsWith("#")
    ) {
      continue;
    }

    const withoutAnchor = rawTarget.split("#")[0];
    if (withoutAnchor.length === 0) {
      continue;
    }

    const decodedTarget = decodeURIComponent(withoutAnchor);
    const resolved = path.resolve(dir, decodedTarget);
    if (!fs.existsSync(resolved)) {
      failures.push(`${file}: missing link target ${rawTarget}`);
    }
  }
  checkToolTableOrder(file, content, failures);
  checkPublicPhrases(file, content, failures);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log(`checked ${markdownFiles.length} markdown files`);

function checkToolTableOrder(file, content, failures) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!toolHeadings.has(lines[i].trim())) {
      continue;
    }

    const headerIndex = findToolTableHeader(lines, i + 1);
    if (headerIndex < 0) {
      failures.push(`${file}: missing tools table under "${lines[i].trim()}"`);
      continue;
    }

    const headers = parseMarkdownRow(lines[headerIndex]);
    const versionIndex = headers.findIndex((header) => header === "Since" || header === "版本");
    const toolIndex = headers.findIndex((header) => header === "工具 / Tool" || header === "Tool" || header === "工具");
    if (versionIndex < 0) {
      failures.push(`${file}: tools table is missing a Since/version column`);
      continue;
    }
    if (toolIndex < 0) {
      failures.push(`${file}: tools table is missing a tool column`);
      continue;
    }
    if (versionIndex !== 0) {
      failures.push(`${file}: tools table must put the Since/version column first`);
    }

    let previous = null;
    for (let j = headerIndex + 2; j < lines.length && lines[j].startsWith("|"); j += 1) {
      const cells = parseMarkdownRow(lines[j]);
      if (!cells.some((cell) => cell.startsWith("`ob_"))) {
        continue;
      }
      const rawVersion = cells[versionIndex];
      const version = parseVersion(rawVersion);
      if (!version) {
        failures.push(`${file}: invalid tool version "${rawVersion}"`);
        continue;
      }
      const toolName = cells[toolIndex].replace(/`/g, "");
      if (previous && compareVersions(previous.version, version) > 0) {
        failures.push(`${file}: tools table version order moves from ${previous.raw} to ${rawVersion}`);
      }
      if (previous && compareVersions(previous.version, version) === 0 && previous.toolName.localeCompare(toolName) > 0) {
        failures.push(`${file}: tools table order moves from ${previous.raw} ${previous.toolName} to ${rawVersion} ${toolName}`);
      }
      previous = { raw: rawVersion, version, toolName };
    }
  }
}

function checkPublicPhrases(file, content, failures) {
  for (const banned of bannedPublicPhrases) {
    if (content.includes(banned.phrase)) {
      failures.push(`${file}: public docs contain "${banned.phrase}"; ${banned.reason}`);
    }
  }
}

function findToolTableHeader(lines, start) {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      return -1;
    }
    if (lines[i].startsWith("|") && (lines[i].includes("Since") || lines[i].includes("版本"))) {
      return i;
    }
  }
  return -1;
}

function parseMarkdownRow(line) {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

function parseVersion(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number(part));
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}
