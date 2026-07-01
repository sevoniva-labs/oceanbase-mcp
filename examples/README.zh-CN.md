# 示例文件

[English](README.en.md) | [返回](../README.md)

| 文件 | 用途 |
| --- | --- |
| [opencode.local.jsonc](opencode.local.jsonc) | 本地 OpenCode stdio 配置。 |
| [opencode.remote.jsonc](opencode.remote.jsonc) | 远程 OpenCode HTTP 配置。 |
| [opencode.remote.assistant.jsonc](opencode.remote.assistant.jsonc) | 使用 OceanBase assistant 的远程 OpenCode HTTP 配置。 |
| [env.local.mysql.example](env.local.mysql.example) | 本地 MySQL 模式 `.env`。 |
| [env.local.oracle.example](env.local.oracle.example) | 本地 Oracle 模式 `.env`。 |
| [env.production.example](env.production.example) | 生产 HTTP 环境变量示例。 |
| [systemd.env.example](systemd.env.example) | `/etc/ob-mcp/ob-mcp.env` 示例。 |
| [business-glossary.example.json](business-glossary.example.json) | 可选业务词映射，用于搜索提示。 |

复制示例后，修改地址、用户、密码、schema 策略和来源 IP allowlist，再运行 `npm run config:doctor`。

## ER HTML 导出

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

默认不会覆盖已有文件；需要覆盖时显式加 `--overwrite`。
