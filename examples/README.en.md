# Examples

[中文](README.zh-CN.md) | [Back](../README.md)

| File | Use |
| --- | --- |
| [opencode.local.jsonc](opencode.local.jsonc) | Local OpenCode stdio config for MySQL mode. |
| [opencode.local.oracle.jsonc](opencode.local.oracle.jsonc) | Local OpenCode stdio config for Oracle mode. |
| [opencode.local.assistant.jsonc](opencode.local.assistant.jsonc) | Local OpenCode stdio config with the OceanBase assistant. |
| [opencode.remote.jsonc](opencode.remote.jsonc) | Remote OpenCode HTTP config. |
| [opencode.remote.assistant.jsonc](opencode.remote.assistant.jsonc) | Remote OpenCode HTTP config with the OceanBase assistant. |
| [env.local.mysql.example](env.local.mysql.example) | Local MySQL-mode `.env`. |
| [env.local.oracle.example](env.local.oracle.example) | Local Oracle-mode `.env`. |
| [env.production.example](env.production.example) | Production HTTP environment example. |
| [systemd.env.example](systemd.env.example) | Example `/etc/ob-mcp/ob-mcp.env`. |
| [business-glossary.example.json](business-glossary.example.json) | Optional business-term mapping for search hints. |
| [metadata-change-workflow.en.md](metadata-change-workflow.en.md) | Metadata snapshot, diff, SQL usage index, and report workflow. |
| [metadata-change-workflow.zh-CN.md](metadata-change-workflow.zh-CN.md) | Chinese metadata change workflow. |

Copy an example, change hosts, users, passwords, schema policy, and IP allowlist, then run `npm run config:doctor`.

## OpenCode Examples

Local MySQL mode:

```bash
cp examples/opencode.local.jsonc opencode.jsonc
opencode mcp list
```

Local Oracle mode:

```bash
cp examples/opencode.local.oracle.jsonc opencode.jsonc
opencode mcp list
```

Use the OceanBase assistant:

```bash
cp examples/opencode.local.assistant.jsonc opencode.jsonc
opencode run "Use the oceanbase MCP server to inspect metadata first, then draft a read-only paged query for the orders table."
```

Remote HTTP:

```bash
cp examples/opencode.remote.assistant.jsonc opencode.jsonc
export OB_MCP_AUTH_TOKEN=change-me
opencode mcp list
```

## ER HTML Export

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

Existing files are not overwritten by default. Add `--overwrite` only when replacing an existing artifact intentionally.

In OpenCode, ask the assistant to inspect relationship evidence first, then call `ob_generate_er_html` for HTML output.

## SQL Scan

```bash
ob-mcp scan-sql --path src --path mapper --ignore generated --index-out snapshots/sql-index.json --format json
```

The scan reports findings only and does not modify code. The optional SQL usage index can be used by metadata impact analysis. For table and column validation, pass a reported SQL snippet to `ob_validate_sql_snippet`.

## Metadata Change Workflow

MySQL mode:

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/mysql-before.json
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
ob-mcp metadata snapshot --schema biz_test --out snapshots/mysql-after.json
ob-mcp metadata diff --before snapshots/mysql-before.json --after snapshots/mysql-after.json --format markdown --out snapshots/mysql-diff.md
ob-mcp metadata report --before snapshots/mysql-before.json --after snapshots/mysql-after.json --sql-index snapshots/sql-index.json --format markdown --out snapshots/mysql-report.md
```

Oracle mode:

```bash
OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot --schema OB_USER --include-oracle-objects --out snapshots/oracle-before.json

OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot --schema OB_USER --include-oracle-objects --out snapshots/oracle-after.json

ob-mcp metadata report --before snapshots/oracle-before.json --after snapshots/oracle-after.json --format html --out snapshots/oracle-report.html
```

See [metadata-change-workflow.en.md](metadata-change-workflow.en.md) for the full sequence.
