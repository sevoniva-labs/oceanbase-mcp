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
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exit(1);
}

console.log(`checked ${markdownFiles.length} markdown files`);
