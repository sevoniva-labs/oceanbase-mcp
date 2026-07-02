# CLI

[中文](../zh-CN/cli.md) | [Back](README.md)

`ob-mcp` starts the stdio MCP server when no command is passed. Subcommands are used for local setup and checks.

## Init

Create OceanBase MCP and OpenCode files in a local project:

```bash
ob-mcp init --mode mysql --schema biz_test
```

From a source checkout:

```bash
npm run build
node dist/index.js init --mode mysql --schema biz_test
```

Oracle mode:

```bash
ob-mcp init --mode oracle --schema OB_USER
```

Generated files:

| File | Purpose |
| --- | --- |
| `.env` | Local OceanBase MCP environment variables. |
| `opencode.jsonc` | Local OpenCode MCP configuration. |
| `.opencode/agents/oceanbase-developer.md` | OpenCode OceanBase agent. |
| `.opencode/skills/oceanbase-query/SKILL.md` | OpenCode query skill. |
| `business-glossary.json` | Business glossary template. |

`init` does not write real passwords. It uses `change-me` as a placeholder. Update `OB_USER`, `OB_PASSWORD`, and `OB_ALLOWED_SCHEMAS` after generation.

## Options

| Option | Description |
| --- | --- |
| `--mode mysql\|oracle` | OceanBase compatibility mode. Defaults to `mysql`. |
| `--host <host>` | OceanBase or OBProxy host. Defaults to `127.0.0.1`. |
| `--port <port>` | OceanBase or OBProxy port. Defaults to `2883`. |
| `--schema <schema>` | Allowed schema. MySQL defaults to `biz_test`; Oracle defaults to the uppercase username. |
| `--username <name>` | OceanBase username. Defaults to `ob_user`. |
| `--tenant <tenant>` | OceanBase tenant. MySQL defaults to `ob_mysql`; Oracle defaults to `ob_oracle`. |
| `--cluster <cluster>` | OceanBase cluster. Defaults to `obcluster`. |
| `--dry-run` | Show generated file paths without writing files. |
| `--force` | Overwrite existing generated files. |

Existing files are not overwritten by default. Use `--force` only when regenerating local setup files intentionally.

## Doctor

Check local config, build output, OpenCode files, business glossary, read-only policy, and OceanBase connectivity:

```bash
ob-mcp doctor
```

From a source checkout:

```bash
npm run config:doctor
```

To check local files and config without opening a database connection:

```bash
ob-mcp doctor --skip-connect
```

Output is JSON. Checks use `pass`, `warn`, and `fail`. `doctor` does not print passwords, tokens, or full connection strings.

## Export ER HTML

Export visible metadata and relationship evidence to a local single-file HTML artifact:

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

From a source checkout:

```bash
npm run build
node dist/index.js export-er --schema biz_test --business-term orders --format detailed --out tmp/order-er.html
```

For larger schemas, export chunked files to a directory:

```bash
ob-mcp export-er --schema biz_test --format interactive --out-dir docs/er --chunk-size 25
```

Supported formats:

| Format | Description |
| --- | --- |
| `static` | Single-file static HTML with the diagram, relationship table, Mermaid, and JSON. |
| `interactive` | Single-file interactive HTML with table search, zoom, drag, auto-fit, table details, and relationship highlighting. |
| `compact` | Compact diagram with tables and main relationships for larger local models. |
| `detailed` | Detailed diagram with columns, primary keys, indexes, and column comments. |

Common options:

| Option | Description |
| --- | --- |
| `--schema <schema>` | Limit the schema. |
| `--table <table>` | Build a local ER view from one table. |
| `--tables <a,b>` | Use an explicit table list. |
| `--business-term <term>` | Match the ER scope from a business term. |
| `--depth <1-3>` | Relationship discovery depth. |
| `--max-tables <n>` | Maximum table count. |
| `--min-confidence <0-1>` | Minimum relationship confidence. |
| `--no-include-inferred` | Keep only high-confidence relationships such as real foreign keys. |
| `--format <format>` | `static`, `interactive`, `compact`, or `detailed`. |
| `--out <file>` | Output file. A safe default name is used when omitted. |
| `--out-dir <dir>` | Write chunked ER files into a directory for larger schemas. |
| `--chunk-size <n>` | Table count per chunk, up to 100. |
| `--overwrite` | Replace an existing output file. Existing files are not overwritten by default. |

Export still goes through MCP read-only policy, schema/table/column permissions, output size limits, and error redaction. The command writes only the local HTML file and never modifies the database.

## Metadata Change

Capture a metadata-only snapshot:

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/before.json
```

Compare two snapshots:

```bash
ob-mcp metadata diff \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --format markdown \
  --out snapshots/diff.md
```

Generate a review report with a SQL usage index:

```bash
ob-mcp metadata report \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --sql-index snapshots/sql-index.json \
  --format markdown \
  --out snapshots/report.md
```

Snapshot options:

| Option | Description |
| --- | --- |
| `--profile <name>` | Use a configured profile. |
| `--schema <schema>` | Limit the captured schema. |
| `--table-pattern <pattern>` | Limit tables by name pattern. |
| `--object-types <list>` | Limit Oracle object types. |
| `--max-tables <n>` | Maximum table count. |
| `--max-columns-per-table <n>` | Maximum columns per table. |
| `--max-objects <n>` | Maximum Oracle object count. |
| `--max-relationships <n>` | Maximum relationship evidence count. |
| `--no-relationships` | Skip relationship discovery. |
| `--no-oracle-objects` | Skip Oracle object metadata. |
| `--format json` | Snapshot output format. |
| `--out <file>` | Output file. |
| `--overwrite` | Replace an existing output file. Existing files are not overwritten by default. |

Diff and report options:

| Option | Description |
| --- | --- |
| `--before <file>` | Previous snapshot file. |
| `--after <file>` | Later snapshot file. |
| `--format json\|markdown` | Diff output format. |
| `--format markdown\|html` | Report output format. |
| `--sql-index <file>` | SQL usage index generated by `scan-sql --index-out`. |
| `--risk-only` | Diff only: keep risk-bearing changes. |
| `--summary-only` | Emit a shorter diff or report. |
| `--title <title>` | Report title. |
| `--out <file>` | Output file. |
| `--overwrite` | Replace an existing output file. Existing files are not overwritten by default. |

Metadata commands read metadata and local files only. They do not execute database changes and do not emit executable DDL.

## Scan Project SQL

Scan local project files for SQL snippets. The command reports findings only and does not modify files:

```bash
ob-mcp scan-sql --path src --path mapper --ignore generated --index-out snapshots/sql-index.json --format json
```

From a source checkout:

```bash
npm run build
node dist/index.js scan-sql --path src --extensions sql,xml,ts,js,java --format text
```

The scanner covers `.sql`, `.xml`, `.ts`, `.js`, and `.java`. It reports file location, SQL type, rough table references, read-only candidate status, `SELECT *`, missing pagination, write statements, and dynamic SQL hints. For database-level table and column validation, pass a reported SQL snippet to `ob_validate_sql_snippet`.

Common options:

| Option | Description |
| --- | --- |
| `--path <path>` | Path to scan. Can be passed more than once. Defaults to the current directory. |
| `--ignore <pattern>` | Path or glob to ignore. Can be passed more than once. Defaults include `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, and `target`. |
| `--extensions <list>` | Extension list, for example `sql,xml,ts,js,java`. |
| `--max-files <n>` | Maximum scanned files. Defaults to `500`. |
| `--max-bytes <n>` | Maximum bytes read per file. Defaults to `524288`. |
| `--format json\|text` | Output format. Defaults to `json`. |
| `--fail-on-risk` | Return a non-zero exit code when risky snippets are found. Useful for local checks or CI. |
| `--index-out <file>` | Write a static SQL usage index JSON file for metadata impact analysis. |
| `--index-overwrite` | Replace an existing SQL usage index file. Existing files are not overwritten by default. |

`scan-sql` does not connect to the database, execute SQL, or write business files. It is a fast project-level locator; before execution, continue to use MCP read-only policy checks, metadata validation, and query preview.
