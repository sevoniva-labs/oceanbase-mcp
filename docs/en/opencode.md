# OpenCode Setup

[中文](../zh-CN/opencode.md) | [Back](README.md)

OpenCode can connect to OceanBase MCP in two ways:

- Local stdio: OpenCode starts `node dist/index.js` on the developer machine.
- Remote HTTP: OpenCode connects to an already deployed MCP HTTP endpoint.

Use local stdio for development. Use remote HTTP when a team shares one controlled gateway.

## Local Stdio

Use the published package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "oceanbase": {
      "type": "local",
      "command": [
        "npx",
        "--registry=https://registry.npmjs.org/",
        "--yes",
        "--package=@sevoniva/oceanbase-mcp@1.4.0",
        "ob-mcp"
      ],
      "enabled": true,
      "environment": {
        "OB_HOST": "127.0.0.1",
        "OB_PORT": "2883",
        "OB_USER": "ob_user@ob_mysql#obcluster",
        "OB_PASSWORD": "ob_password",
        "OB_COMPATIBILITY": "mysql",
        "OB_ALLOWED_SCHEMAS": "biz_test",
        "OB_ALLOW_SELECT_STAR": "false"
      }
    }
  }
}
```

For source checkout development, build first:

```bash
npm install
npm run build
```

Then use the project [opencode.jsonc](../../opencode.jsonc):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "oceanbase": {
      "type": "local",
      "command": ["node", "dist/index.js"],
      "enabled": true,
      "environment": {
        "OB_HOST": "127.0.0.1",
        "OB_PORT": "2883",
        "OB_USER": "ob_user@ob_mysql#obcluster",
        "OB_PASSWORD": "ob_password",
        "OB_COMPATIBILITY": "mysql",
        "OB_ALLOWED_SCHEMAS": "biz_test",
        "OB_ALLOW_SELECT_STAR": "false"
      }
    }
  }
}
```

Check:

```bash
opencode mcp list
```

Run:

```bash
opencode run "Use the oceanbase MCP server to run SELECT 1 AS ok and return only the result."
```

## Windows Developer Client

Windows is supported as a local developer client. Clone the repository, install Node.js 20+, build the project, and use the same local OpenCode config.

If OpenCode cannot resolve a relative path from your working directory, use an absolute Windows path in the command:

```jsonc
"command": ["node", "C:\\path\\to\\oceanbase-mcp\\dist\\index.js"]
```

Do not treat Windows as the recommended production server platform for this gateway.

## Remote HTTP

Deploy the HTTP server first. Then configure OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "oceanbase": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer ${OB_MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

For remote HTTP, the server side must also set:

```bash
OB_MCP_AUTH_TOKEN_FILE=/run/secrets/ob_mcp_auth_token
OB_MCP_ALLOWED_HOSTS=mcp.example.com
OB_MCP_ALLOWED_IPS=203.0.113.10,10.0.0.0/8
```

`OB_MCP_ALLOWED_IPS` should contain approved client NAT addresses, VPN CIDRs, or trusted reverse-proxy source ranges.

## OceanBase Assistant

The repository includes an OpenCode agent and skill:

- [.opencode/agents/oceanbase-developer.md](../../.opencode/agents/oceanbase-developer.md)
- [.opencode/skills/oceanbase-query/SKILL.md](../../.opencode/skills/oceanbase-query/SKILL.md)

Keep both directories at the project root. OpenCode loads the `oceanbase-developer` agent inside that project. For remote HTTP, see [opencode.remote.assistant.jsonc](../../examples/opencode.remote.assistant.jsonc).

The agent uses this query workflow:

1. Use `ob_search_everything`, the business glossary, schema map, or column search to confirm tables and fields.
2. Read table context, table summary, or onboarding documentation before choosing tables and joins.
3. Use `ob_prepare_query` or `ob_build_select` to generate explicit-column read-only SQL.
4. Use `ob_lint_sql` or `ob_query_preview` before execution.
5. Use query sessions and paged tools for data inspection.
6. Use table profiles, column profiles, or value distribution tools when field distributions are needed.
7. For ER work, plan schema-wide exports with `ob_plan_er_export`; use inline ER only for small scopes and cluster CLI export for larger schemas.
8. Summarize SQL, row count, page state, masking, truncation, and assumptions.

Do not let the agent guess table names, column names, or relationships. When context is insufficient, provide a business term, schema, or table name first.

For large schemas, do not ask the agent to generate a full inline ER diagram. Ask it to run `ob_plan_er_export`, review warnings, stats, and the suggested strategy, then export a local cluster directory with `ob-mcp export-er --out-dir`.

For iteration metadata review, use this workflow:

1. Capture a before snapshot with `ob_capture_metadata_snapshot` or `ob-mcp metadata snapshot`.
2. Build a project SQL usage index with `ob-mcp scan-sql --index-out`.
3. Capture an after snapshot.
4. Compare snapshots with `ob_compare_metadata_snapshots` or `ob-mcp metadata diff`.
5. Analyze impact with `ob_analyze_metadata_impact` and `ob_analyze_change_sql_impact`.
6. Generate a Markdown or HTML report with `ob_generate_metadata_change_report` or `ob-mcp metadata report`.
7. Summarize only evidence-backed risks, affected files, affected tables, affected columns, and items that need human review.

The agent must not invent relationships or SQL usages. Metadata-change conclusions must come from snapshot diff, SQL index, relationship metadata, or business glossary evidence.

## Oracle Mode

For Oracle compatibility:

```jsonc
"environment": {
  "OB_HOST": "127.0.0.1",
  "OB_PORT": "2883",
  "OB_USER": "ob_user@ob_oracle#obcluster",
  "OB_PASSWORD": "ob_password",
  "OB_COMPATIBILITY": "oracle",
  "OB_ALLOWED_SCHEMAS": "OB_USER"
}
```

## Common Checks

```bash
npm run config:doctor
npm run mcp:smoke
npm run http:smoke
```

If OpenCode shows the server as disconnected:

- Run `npm run build`.
- Check the `command` path.
- Check `OB_USER` format: `user@tenant#cluster`.
- Check `OB_ALLOWED_SCHEMAS`.
- Run `npm run smoke` to verify the database connection outside MCP.
