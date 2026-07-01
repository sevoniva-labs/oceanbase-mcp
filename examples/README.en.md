# Examples

[中文](README.zh-CN.md) | [Back](../README.md)

| File | Use |
| --- | --- |
| [opencode.local.jsonc](opencode.local.jsonc) | Local OpenCode stdio config. |
| [opencode.remote.jsonc](opencode.remote.jsonc) | Remote OpenCode HTTP config. |
| [opencode.remote.assistant.jsonc](opencode.remote.assistant.jsonc) | Remote OpenCode HTTP config with the OceanBase assistant. |
| [env.local.mysql.example](env.local.mysql.example) | Local MySQL-mode `.env`. |
| [env.local.oracle.example](env.local.oracle.example) | Local Oracle-mode `.env`. |
| [env.production.example](env.production.example) | Production HTTP environment example. |
| [systemd.env.example](systemd.env.example) | Example `/etc/ob-mcp/ob-mcp.env`. |
| [business-glossary.example.json](business-glossary.example.json) | Optional business-term mapping for search hints. |

Copy an example, change hosts, users, passwords, schema policy, and IP allowlist, then run `npm run config:doctor`.

## ER HTML Export

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

Existing files are not overwritten by default. Add `--overwrite` only when replacing an existing artifact intentionally.

## SQL Scan

```bash
ob-mcp scan-sql --path src --path mapper --ignore generated --format json
```

The scan reports findings only and does not modify code. For table and column validation, pass a reported SQL snippet to `ob_validate_sql_snippet`.
