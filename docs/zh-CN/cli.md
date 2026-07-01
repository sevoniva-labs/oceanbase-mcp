# CLI

[English](../en/cli.md) | [返回](README.md)

`ob-mcp` 不带参数时启动 stdio MCP server。带子命令时用于本地初始化和检查。

## 初始化

在新的本地项目目录中生成 OceanBase MCP 和 OpenCode 配置：

```bash
ob-mcp init --mode mysql --schema biz_test
```

源码仓库内也可以直接运行：

```bash
npm run build
node dist/index.js init --mode mysql --schema biz_test
```

Oracle 模式：

```bash
ob-mcp init --mode oracle --schema OB_USER
```

生成文件：

| 文件 | 用途 |
| --- | --- |
| `.env` | 本地 OceanBase MCP 环境变量。 |
| `opencode.jsonc` | OpenCode 本地 MCP 配置。 |
| `.opencode/agents/oceanbase-developer.md` | OpenCode OceanBase agent。 |
| `.opencode/skills/oceanbase-query/SKILL.md` | OpenCode 查询 skill。 |
| `business-glossary.json` | 业务词映射模板。 |

`init` 不写入真实密码，默认使用 `change-me` 占位。生成后请修改 `OB_USER`、`OB_PASSWORD` 和 `OB_ALLOWED_SCHEMAS`。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--mode mysql\|oracle` | OceanBase 兼容模式。默认 `mysql`。 |
| `--host <host>` | OceanBase 或 OBProxy 地址。默认 `127.0.0.1`。 |
| `--port <port>` | OceanBase 或 OBProxy 端口。默认 `2883`。 |
| `--schema <schema>` | 允许访问的 schema。MySQL 默认 `biz_test`，Oracle 默认用户名大写。 |
| `--username <name>` | OceanBase 用户名。默认 `ob_user`。 |
| `--tenant <tenant>` | OceanBase tenant。MySQL 默认 `ob_mysql`，Oracle 默认 `ob_oracle`。 |
| `--cluster <cluster>` | OceanBase cluster。默认 `obcluster`。 |
| `--dry-run` | 只显示将生成的文件，不写入。 |
| `--force` | 覆盖已存在的生成文件。 |

默认不会覆盖已有文件。确实需要重新生成时再使用 `--force`。

## Doctor

检查本地配置、构建产物、OpenCode 文件、业务字典、只读策略和 OceanBase 连接：

```bash
ob-mcp doctor
```

源码仓库内也可以运行：

```bash
npm run config:doctor
```

如果只想检查本地文件和配置，不检查数据库连接：

```bash
ob-mcp doctor --skip-connect
```

输出为 JSON，检查项使用 `pass`、`warn`、`fail` 标记。`doctor` 不输出密码、token 或完整连接串。
