# 接入 OpenCode

[English](../en/opencode.md) | [返回](README.md)

OpenCode 有两种接入方式：

- 本地 stdio：OpenCode 在开发者机器上启动 `node dist/index.js`。
- 远程 HTTP：OpenCode 连接已经部署好的 MCP HTTP endpoint。

开发时建议用本地 stdio。团队共享网关时使用远程 HTTP。

## 本地 Stdio

先构建：

```bash
npm install
npm run build
```

使用项目内置的 [opencode.jsonc](../../opencode.jsonc)：

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
