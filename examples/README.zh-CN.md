# 示例文件

[English](README.en.md) | [返回](../README.md)

| 文件 | 用途 |
| --- | --- |
| [opencode.local.jsonc](opencode.local.jsonc) | 本地 OpenCode stdio 配置。 |
| [opencode.remote.jsonc](opencode.remote.jsonc) | 远程 OpenCode HTTP 配置。 |
| [env.local.mysql.example](env.local.mysql.example) | 本地 MySQL 模式 `.env`。 |
| [env.local.oracle.example](env.local.oracle.example) | 本地 Oracle 模式 `.env`。 |
| [env.production.example](env.production.example) | 生产 HTTP 环境变量示例。 |
| [systemd.env.example](systemd.env.example) | `/etc/ob-mcp/ob-mcp.env` 示例。 |

复制示例后，修改地址、用户、密码、schema 策略和来源 IP allowlist，再运行 `npm run config:doctor`。
