import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { extractSqlSnippetsFromContent, type SqlScanSnippet } from "../../sql-scan.js";

export type ProjectQuerySource = {
  type: "inline";
  warnings: string[];
} | {
  type: "file";
  file: string;
  line: number;
  requestedLine?: number;
  snippetSource: SqlScanSnippet["source"];
  dynamic: boolean;
  snippetCount: number;
  warnings: string[];
};

const PROJECT_QUERY_ALLOWED_EXTENSIONS = new Set([".sql", ".xml", ".ts", ".js", ".java"]);
const PROJECT_QUERY_MAX_FILE_BYTES = 512 * 1024;

export function resolveProjectQuerySource(
  sql: string | undefined,
  filePath: string | undefined,
  line: number | undefined
): { sql: string; source: ProjectQuerySource } {
  const inlineSql = sql?.trim();
  const projectFile = filePath?.trim();
  if (Boolean(inlineSql) === Boolean(projectFile)) {
    throw new Error("Pass exactly one of sql or filePath.");
  }
  if (inlineSql) {
    return { sql: inlineSql, source: { type: "inline", warnings: [] } };
  }

  const root = process.cwd();
  const absPath = resolve(root, projectFile!);
  const relPath = relative(root, absPath);
  if (!relPath || relPath.startsWith("..") || relPath.startsWith("/")) {
    throw new Error("filePath must point to a file under the current project directory.");
  }
  const ext = extname(absPath).toLowerCase();
  if (!PROJECT_QUERY_ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("filePath must use one of .sql, .xml, .ts, .js, or .java.");
  }
  const content = readProjectSqlFile(absPath);
  const snippets = extractSqlSnippetsFromContent(ext, content);
  if (snippets.length === 0) {
    throw new Error("No SQL snippet was found in filePath.");
  }
  const snippet = selectProjectSqlSnippet(snippets, line);
  return {
    sql: snippet.sql,
    source: {
      type: "file",
      file: relPath,
      line: snippet.line,
      requestedLine: line,
      snippetSource: snippet.source,
      dynamic: snippet.dynamic,
      snippetCount: snippets.length,
      warnings: snippet.dynamic
        ? ["SQL contains dynamic placeholders or template interpolation; validate the rendered SQL before execution."]
        : []
    }
  };
}

function readProjectSqlFile(absPath: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("filePath must point to a regular file.");
    }
    if (stat.size > PROJECT_QUERY_MAX_FILE_BYTES) {
      throw new Error(`filePath exceeds the ${PROJECT_QUERY_MAX_FILE_BYTES} byte scan limit.`);
    }
    return readFileSync(fd, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("filePath ")) {
      throw error;
    }
    throw new Error("filePath could not be read safely.");
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function selectProjectSqlSnippet(snippets: SqlScanSnippet[], line: number | undefined): SqlScanSnippet {
  if (!line) {
    return snippets[0];
  }
  return snippets.reduce((best, item) => {
    const bestDistance = Math.abs(best.line - line);
    const itemDistance = Math.abs(item.line - line);
    return itemDistance < bestDistance ? item : best;
  }, snippets[0]);
}
