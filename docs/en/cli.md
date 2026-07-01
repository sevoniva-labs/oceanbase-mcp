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
