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
| [metadata-change-workflow.zh-CN.md](metadata-change-workflow.zh-CN.md) | 元数据快照、diff、SQL 使用索引和报告流程。 |
| [metadata-change-workflow.en.md](metadata-change-workflow.en.md) | 英文元数据变更流程。 |

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

大 schema：

```bash
ob-mcp export-er --schema biz_test --format interactive --relationship-mode foreign_key --strategy table-prefix --out-dir docs/er --chunk-size 25
```

OpenCode 中应先让 assistant 调用 `ob_plan_er_export`。规划结果较小时才生成 inline ER；大 schema 使用 CLI cluster 导出。

## SQL 扫描

```bash
ob-mcp scan-sql --path src --path mapper --ignore generated --index-out snapshots/sql-index.json --format json
```

扫描只输出报告，不修改代码。可选 SQL 使用索引用于元数据影响分析。需要进一步校验表字段时，把报告中的 SQL 交给 `ob_validate_sql_snippet`。

## 元数据变更流程

MySQL 模式：

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/mysql-before.json
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
ob-mcp metadata snapshot --schema biz_test --out snapshots/mysql-after.json
ob-mcp metadata diff --before snapshots/mysql-before.json --after snapshots/mysql-after.json --format markdown --out snapshots/mysql-diff.md
ob-mcp metadata report --before snapshots/mysql-before.json --after snapshots/mysql-after.json --sql-index snapshots/sql-index.json --format markdown --out snapshots/mysql-report.md
```

Oracle 模式：

```bash
OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot --schema OB_USER --include-oracle-objects --out snapshots/oracle-before.json

OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot --schema OB_USER --include-oracle-objects --out snapshots/oracle-after.json

ob-mcp metadata report --before snapshots/oracle-before.json --after snapshots/oracle-after.json --format html --out snapshots/oracle-report.html
```

完整流程见 [metadata-change-workflow.zh-CN.md](metadata-change-workflow.zh-CN.md)。
