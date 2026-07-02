# Metadata Change Analysis

[中文](../zh-CN/metadata-change.md) | [Back](README.md)

OceanBase MCP can capture metadata-only snapshots, compare iteration changes, find project SQL usages, and generate review reports. The workflow is read-only: it reads OceanBase metadata and local project files, but it does not execute schema changes or write business code.

## Workflow

```bash
mkdir -p snapshots

ob-mcp metadata snapshot \
  --schema biz_test \
  --out snapshots/before.json

ob-mcp scan-sql \
  --path src \
  --path mapper \
  --index-out snapshots/sql-index.json \
  --format text

ob-mcp metadata snapshot \
  --schema biz_test \
  --out snapshots/after.json

ob-mcp metadata diff \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --format markdown \
  --out snapshots/diff.md

ob-mcp metadata report \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --sql-index snapshots/sql-index.json \
  --format markdown \
  --out snapshots/report.md
```

Use `--overwrite` or `--index-overwrite` only when replacing a known local artifact.

## MCP Tools

| Tool | Use |
| --- | --- |
| `ob_capture_metadata_snapshot` | Capture bounded metadata snapshots for MySQL or Oracle mode. |
| `ob_compare_metadata_snapshots` | Compare two snapshots and return added, removed, and changed metadata objects. |
| `ob_find_sql_usages` | Search a static SQL usage index for table, column, or business-term references. |
| `ob_analyze_change_sql_impact` | Analyze SQL impact from a supplied metadata diff and SQL usage index. |
| `ob_analyze_metadata_impact` | Summarize upstream, downstream, SQL, relationship, and glossary impact from diff evidence. |
| `ob_generate_metadata_change_report` | Generate Markdown or simple HTML reports for review. |

## Snapshot Scope

Snapshots include schema, tables, columns, indexes, constraints, partitions, relationships, table statistics, comments, and Oracle object metadata where available. They do not include sample rows or business data values.

Common limits:

| Option | Purpose |
| --- | --- |
| `--schema` | Limit the captured schema. |
| `--table-pattern` | Limit tables by name pattern. |
| `--max-tables` | Cap table count. |
| `--max-columns-per-table` | Cap columns per table. |
| `--max-objects` | Cap Oracle object metadata. |
| `--max-relationships` | Cap relationship evidence. |
| `--no-relationships` | Skip relationship discovery. |
| `--no-oracle-objects` | Skip Oracle object metadata. |

Large schemas should use `--schema`, `--table-pattern`, and max limits. Snapshot output includes warnings when limits truncate metadata.

## SQL Usage Index

`ob-mcp scan-sql` scans `.sql`, `.xml`, `.ts`, `.js`, and `.java` files. It reports SQL type, tables, columns, dynamic SQL signals, MyBatis `${}` / `#{}` hints, read-only candidate status, pagination risks, and dialect hints.

The SQL usage index is static analysis only. It does not connect to OceanBase and does not modify files.

## Reports

Reports include:

- Snapshot scope and summary.
- Added, removed, and changed objects.
- Breaking changes.
- Table, column, index, constraint, partition, and Oracle object changes.
- SQL usage impact with file and line evidence.
- Relationship and glossary evidence.
- Review checklist and known limits.

Reports do not include executable `ALTER`, `CREATE`, `DROP`, `GRANT`, or index DDL.

## OpenCode Use

Ask OpenCode to follow this sequence:

1. Capture a before snapshot.
2. Build a SQL usage index from the project.
3. Capture an after snapshot.
4. Compare snapshots.
5. Analyze impact with the SQL index.
6. Generate a Markdown or HTML report.
7. Summarize evidence, risks, and items that need human review.

OpenCode should not infer missing relationships or SQL usages. Conclusions must come from snapshot diff, SQL index, relationship metadata, or the business glossary.

## MySQL And Oracle Notes

- MySQL mode reads `information_schema` metadata.
- Oracle mode reads `USER_*` or `ALL_*` metadata depending on schema scope.
- Oracle object diffs can include views, sequences, synonyms, procedures, functions, and packages.
- Object casing follows the configured compatibility mode.

## Safety Boundary

Metadata change analysis is advisory. It can say that a removed column may affect a mapper or report, but it must not output executable database change SQL. Use the generated report as review input before a separate database change process.
