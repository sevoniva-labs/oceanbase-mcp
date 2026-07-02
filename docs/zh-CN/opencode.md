# 接入 OpenCode

[English](../en/opencode.md) | [返回](README.md)

OpenCode 有两种接入方式：

- 本地 stdio：OpenCode 在开发者机器上启动 `node dist/index.js`。
- 远程 HTTP：OpenCode 连接已经部署好的 MCP HTTP endpoint。

开发时建议用本地 stdio。团队共享网关时使用远程 HTTP。

## 本地 Stdio

使用已发布的 npm 包：

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
        "--package=@sevoniva/oceanbase-mcp@1.1.6",
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

如果从源码开发，先构建：

```bash
npm install
npm run build
```

然后使用项目内置的 [opencode.jsonc](../../opencode.jsonc)：

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

检查：

```bash
opencode mcp list
```

运行：

```bash
opencode run "Use the oceanbase MCP server to run SELECT 1 AS ok and return only the result."
```

## Windows 开发客户端

Windows 支持作为本地开发客户端。克隆仓库，安装 Node.js 20+，构建项目，然后使用相同的本地 OpenCode 配置。

如果 OpenCode 无法从当前目录解析相对路径，可以在 command 中使用 Windows 绝对路径：

```jsonc
"command": ["node", "C:\\path\\to\\oceanbase-mcp\\dist\\index.js"]
```

不要把 Windows 作为这个网关的推荐生产服务器平台。

## 远程 HTTP

先部署 HTTP server，然后配置 OpenCode：

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

远程 HTTP 服务端还必须设置：

```bash
OB_MCP_AUTH_TOKEN_FILE=/run/secrets/ob_mcp_auth_token
OB_MCP_ALLOWED_HOSTS=mcp.example.com
OB_MCP_ALLOWED_IPS=203.0.113.10,10.0.0.0/8
```

`OB_MCP_ALLOWED_IPS` 应填写被允许的客户端出口 NAT 地址、VPN 网段或可信反向代理来源网段。

## OceanBase Assistant

仓库提供 OpenCode agent 和 skill：

- [.opencode/agents/oceanbase-developer.md](../../.opencode/agents/oceanbase-developer.md)
- [.opencode/skills/oceanbase-query/SKILL.md](../../.opencode/skills/oceanbase-query/SKILL.md)

把这两个目录保留在项目根目录，OpenCode 会在该项目内加载 `oceanbase-developer` agent。远程 HTTP 可参考 [opencode.remote.assistant.jsonc](../../examples/opencode.remote.assistant.jsonc)。

该 agent 的查询流程固定为：

1. 先用 `ob_search_everything`、业务字典、schema map 或字段搜索确认表和字段。
2. 再读取表上下文、表摘要或入门文档，不猜表名、字段名和关系。
3. 用 `ob_prepare_query` 或 `ob_build_select` 生成显式字段的只读 SQL。
4. 执行前用 `ob_lint_sql` 或 `ob_query_preview` 检查策略和风险。
5. 使用查询会话和分页工具查看数据。
6. 需要理解字段分布时，使用表画像、字段画像或值分布工具。
7. 需要 ER 图时，schema 级请求先用 `ob_plan_er_export` 规划；小范围才使用 inline ER，大 schema 使用 CLI 分片导出。
8. 汇总 SQL、行数、分页、脱敏、截断和假设。

不要让 agent 猜表名、字段名或关系。信息不足时，应先补充业务词、schema 或表名。

大 schema 不要要求 agent 直接生成全量 inline ER。应先调用 `ob_plan_er_export`，查看 warnings、stats 和建议策略，再用 `ob-mcp export-er --out-dir` 本地分片导出。

迭代元数据评审使用这个流程：

1. 用 `ob_capture_metadata_snapshot` 或 `ob-mcp metadata snapshot` 采集变更前快照。
2. 用 `ob-mcp scan-sql --index-out` 扫描项目 SQL 使用索引。
3. 采集变更后快照。
4. 用 `ob_compare_metadata_snapshots` 或 `ob-mcp metadata diff` 对比快照。
5. 用 `ob_analyze_metadata_impact` 和 `ob_analyze_change_sql_impact` 分析影响。
6. 用 `ob_generate_metadata_change_report` 或 `ob-mcp metadata report` 生成 Markdown 或 HTML 报告。
7. 只汇总有证据的风险、受影响文件、受影响表、受影响字段和需要人工确认的事项。

agent 不得臆造关系或 SQL 使用位置。元数据变更结论必须来自快照 diff、SQL 使用索引、关系元数据或业务字典证据。

## Oracle 模式

Oracle 兼容模式：

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

## 常用检查

```bash
npm run config:doctor
npm run mcp:smoke
npm run http:smoke
```

如果 OpenCode 显示 disconnected：

- 先运行 `npm run build`。
- 检查 `command` 路径。
- 检查 `OB_USER` 格式：`user@tenant#cluster`。
- 检查 `OB_ALLOWED_SCHEMAS`。
- 运行 `npm run smoke`，先确认 MCP 外的数据库连接可用。
