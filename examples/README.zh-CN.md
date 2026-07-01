# 示例文件

[English](README.en.md) | [返回](../README.md)

| 文件 | 用途 |
| --- | --- |
| [opencode.local.jsonc](opencode.local.jsonc) | 本地 OpenCode stdio 配置，MySQL 模式。 |
| [opencode.local.oracle.jsonc](opencode.local.oracle.jsonc) | 本地 OpenCode stdio 配置，Oracle 模式。 |
| [opencode.local.assistant.jsonc](opencode.local.assistant.jsonc) | 本地 OpenCode stdio 配置，并启用 OceanBase assistant。 |
| [opencode.remote.jsonc](opencode.remote.jsonc) | 远程 OpenCode HTTP 配置。 |
| [opencode.remote.assistant.jsonc](opencode.remote.assistant.jsonc) | 使用 OceanBase assistant 的远程 OpenCode HTTP 配置。 |
| [env.local.mysql.example](env.local.mysql.example) | 本地 MySQL 模式 `.env`。 |
| [env.local.oracle.example](env.local.oracle.example) | 本地 Oracle 模式 `.env`。 |
| [env.production.example](env.production.example) | 生产 HTTP 环境变量示例。 |
| [systemd.env.example](systemd.env.example) | `/etc/ob-mcp/ob-mcp.env` 示例。 |
| [business-glossary.example.json](business-glossary.example.json) | 可选业务词映射，用于搜索提示。 |

复制示例后，修改地址、用户、密码、schema 策略和来源 IP allowlist，再运行 `npm run config:doctor`。

## OpenCode 示例

本地 MySQL 模式：

```bash
cp examples/opencode.local.jsonc opencode.jsonc
opencode mcp list
```

本地 Oracle 模式：

```bash
cp examples/opencode.local.oracle.jsonc opencode.jsonc
opencode mcp list
```

使用 OceanBase assistant：

```bash
cp examples/opencode.local.assistant.jsonc opencode.jsonc
opencode run "使用 oceanbase MCP，先查元数据，再为订单表生成只读分页查询。"
```

远程 HTTP：

```bash
cp examples/opencode.remote.assistant.jsonc opencode.jsonc
export OB_MCP_AUTH_TOKEN=change-me
opencode mcp list
```

## ER HTML 导出

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

默认不会覆盖已有文件；需要覆盖时显式加 `--overwrite`。

OpenCode 中也可以要求 assistant 先查关系证据，再调用 `ob_generate_er_html` 生成 HTML 内容。

## SQL 扫描

```bash
ob-mcp scan-sql --path src --path mapper --ignore generated --format json
```

扫描只输出报告，不修改代码。需要进一步校验表字段时，把报告中的 SQL 交给 `ob_validate_sql_snippet`。
