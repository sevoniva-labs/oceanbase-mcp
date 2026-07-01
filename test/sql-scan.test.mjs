import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildSqlUsageIndex, parseScanSqlArgs, renderScanSqlText, runScanSqlCommand, scanSqlProject } from "../dist/sql-scan.js";

test("parseScanSqlArgs parses paths, ignore patterns, limits, and output mode", () => {
  assert.deepEqual(parseScanSqlArgs([
    "--path", "src",
    "--path=sql",
    "--ignore", "dist,generated/**",
    "--extensions", "sql,xml,ts",
    "--max-files", "20",
    "--max-bytes", "4096",
    "--format", "text",
    "--fail-on-risk",
    "--index-out", "sql-index.json",
    "--index-overwrite"
  ]), {
    paths: ["src", "sql"],
    ignore: ["dist", "generated/**"],
    extensions: [".sql", ".xml", ".ts"],
    maxFiles: 20,
    maxBytes: 4096,
    format: "text",
    failOnRisk: true,
    indexOut: "sql-index.json",
    indexOverwrite: true
  });

  assert.throws(() => parseScanSqlArgs(["--format", "yaml"]), /--format/);
  assert.throws(() => parseScanSqlArgs(["--max-files", "0"]), /--max-files/);
});

test("scanSqlProject reports SQL snippets without modifying files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-scan-sql-"));
  try {
    writeFileSync(join(dir, "mapper.xml"), `
      <mapper namespace="OrderMapper">
        <select id="findOrders">
          SELECT id, status FROM orders
          <where>
            <if test="status != null">status = #{status}</if>
          </where>
        </select>
        <update id="updateOrder">UPDATE orders SET status = #{status}</update>
      </mapper>
    `);
    writeFileSync(join(dir, "query.ts"), "const sql = `SELECT * FROM users WHERE id = ${id}`;\n");
    writeFileSync(join(dir, "reports.sql"), "SELECT id FROM audit_log LIMIT 10;\nDELETE FROM audit_log;\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "ignored.sql"), "DELETE FROM ignored_table;\n");
    mkdirSync(join(dir, "generated"));
    writeFileSync(join(dir, "generated", "skip.sql"), "UPDATE generated_table SET name = 'x';\n");

    const report = scanSqlProject({
      cwd: dir,
      ignore: ["generated"],
      maxFiles: 20
    });

    assert.equal(report.scannedFiles, 3);
    assert.equal(report.snippetCount, 5);
    assert.equal(report.summary.byType.select, 3);
    assert.equal(report.summary.byType.update, 1);
    assert.equal(report.summary.byType.delete, 1);
    assert.equal(report.summary.risks.not_read_only, 2);
    assert(report.findings.some((finding) =>
      finding.file === "query.ts" &&
      finding.risks.includes("select_star") &&
      finding.risks.includes("dynamic_sql") &&
      finding.dynamicSql.detected &&
      finding.dynamicSql.sources.includes("template_interpolation") &&
      finding.warnings.some((warning) => warning.includes("dynamic"))
    ));
    assert(report.findings.some((finding) =>
      finding.file === "mapper.xml" &&
      finding.source === "xml_mapper" &&
      finding.tables.includes("orders") &&
      finding.columns.includes("status") &&
      finding.dynamicSql.sources.includes("mybatis_if")
    ));
    assert(!report.findings.some((finding) => finding.file.includes("node_modules")));
    assert(!report.findings.some((finding) => finding.file.includes("generated")));

    const text = renderScanSqlText(report);
    assert.match(text, /snippets: 5/);
    assert.match(text, /not_read_only/);

    const index = buildSqlUsageIndex(report);
    assert.equal(index.indexVersion, "1.1");
    assert(index.entries.some((entry) => entry.file === "mapper.xml" && entry.tables.includes("orders")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScanSqlCommand writes SQL usage index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-mcp-scan-index-"));
  try {
    writeFileSync(join(dir, "query.sql"), "SELECT id, status FROM orders WHERE status = 'PAID' LIMIT 10;\n");
    const code = await runScanSqlCommand([
      "--path", ".",
      "--index-out", "sql-usage-index.json",
      "--format", "text"
    ], dir);
    assert.equal(code, 0);
    const index = JSON.parse(readFileSync(join(dir, "sql-usage-index.json"), "utf8"));
    assert.equal(index.indexVersion, "1.1");
    assert.equal(index.entries[0].file, "query.sql");
    assert.deepEqual(index.entries[0].tables, ["orders"]);
    assert(index.entries[0].columns.includes("status"));
    assert(index.entries[0].dialectHints.includes("mysql_limit"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
