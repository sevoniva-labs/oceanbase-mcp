# Metadata Change Workflow Example

[中文](metadata-change-workflow.zh-CN.md) | [Back](README.en.md)

This example captures metadata before and after an iteration, scans project SQL, compares snapshots, and generates a review report. It is read-only and does not execute database changes.

## MySQL Mode

```bash
mkdir -p snapshots

ob-mcp metadata snapshot \
  --schema biz_test \
  --max-tables 100 \
  --max-columns-per-table 120 \
  --out snapshots/mysql-before.json

ob-mcp scan-sql \
  --path src \
  --path mapper \
  --extensions sql,xml,ts,js,java \
  --index-out snapshots/sql-index.json \
  --format text

ob-mcp metadata snapshot \
  --schema biz_test \
  --max-tables 100 \
  --max-columns-per-table 120 \
  --out snapshots/mysql-after.json

ob-mcp metadata diff \
  --before snapshots/mysql-before.json \
  --after snapshots/mysql-after.json \
  --format markdown \
  --out snapshots/mysql-diff.md

ob-mcp metadata report \
  --before snapshots/mysql-before.json \
  --after snapshots/mysql-after.json \
  --sql-index snapshots/sql-index.json \
  --format markdown \
  --title "Iteration Metadata Review" \
  --out snapshots/mysql-report.md
```

## Oracle Mode

```bash
mkdir -p snapshots

OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot \
  --schema OB_USER \
  --include-oracle-objects \
  --max-objects 200 \
  --out snapshots/oracle-before.json

OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot \
  --schema OB_USER \
  --include-oracle-objects \
  --max-objects 200 \
  --out snapshots/oracle-after.json

ob-mcp metadata diff \
  --before snapshots/oracle-before.json \
  --after snapshots/oracle-after.json \
  --format markdown \
  --out snapshots/oracle-diff.md

ob-mcp metadata report \
  --before snapshots/oracle-before.json \
  --after snapshots/oracle-after.json \
  --format html \
  --title "Oracle Metadata Review" \
  --out snapshots/oracle-report.html
```

## OpenCode Prompt

```text
Use the oceanbase MCP server for an iteration metadata review.
Use existing snapshots if I provide them; otherwise capture before and after snapshots.
Build a SQL usage index from src and mapper.
Compare snapshots, analyze SQL impact, then generate a Markdown report.
Only report evidence-backed risks and do not output executable DDL.
```

Use `--overwrite` or `--index-overwrite` only when replacing known local artifacts.
