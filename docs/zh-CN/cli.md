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

## 导出 ER HTML

将可见元数据和关系证据导出为本地单文件 HTML：

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

源码仓库内也可以运行：

```bash
npm run build
node dist/index.js export-er --schema biz_test --business-term 订单 --format detailed --out tmp/order-er.html
```

支持格式：

| 格式 | 说明 |
| --- | --- |
| `static` | 单文件静态 HTML，包含图、关系清单、Mermaid 和 JSON。 |
| `interactive` | 单文件交互 HTML，支持搜索和缩放。 |
| `compact` | 紧凑图，只显示表和主关系，适合较大的局部模型。 |
| `detailed` | 详细图，显示字段、主键、索引和字段注释。 |

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--schema <schema>` | 限定 schema。 |
| `--table <table>` | 从单表出发生成局部 ER。 |
| `--tables <a,b>` | 指定多张表。 |
| `--business-term <term>` | 按业务词匹配表范围。 |
| `--depth <1-3>` | 关系发现深度。 |
| `--max-tables <n>` | 最大表数量。 |
| `--min-confidence <0-1>` | 最低关系置信度。 |
| `--no-include-inferred` | 只保留真实外键等高可信关系。 |
| `--format <format>` | `static`、`interactive`、`compact` 或 `detailed`。 |
| `--out <file>` | 输出文件。未指定时使用安全默认文件名。 |
| `--overwrite` | 覆盖已有输出文件。默认不覆盖。 |

导出过程仍走 MCP 的只读策略、schema/table/column 权限、输出大小限制和错误脱敏。命令只写本地 HTML 文件，不修改数据库。

## 元数据变更

采集纯元数据快照：

```bash
ob-mcp metadata snapshot --schema biz_test --out snapshots/before.json
```

对比两份快照：

```bash
ob-mcp metadata diff \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --format markdown \
  --out snapshots/diff.md
```

结合 SQL 使用索引生成评审报告：

```bash
ob-mcp metadata report \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --sql-index snapshots/sql-index.json \
  --format markdown \
  --out snapshots/report.md
```

快照参数：

| 参数 | 说明 |
| --- | --- |
| `--profile <name>` | 使用指定 profile。 |
| `--schema <schema>` | 限定采集 schema。 |
| `--table-pattern <pattern>` | 按表名模式限定范围。 |
| `--object-types <list>` | 限定 Oracle 对象类型。 |
| `--max-tables <n>` | 最大表数量。 |
| `--max-columns-per-table <n>` | 单表最大字段数量。 |
| `--max-objects <n>` | 最大 Oracle 对象数量。 |
| `--max-relationships <n>` | 最大关系证据数量。 |
| `--no-relationships` | 跳过关系发现。 |
| `--no-oracle-objects` | 跳过 Oracle 对象元数据。 |
| `--format json` | 快照输出格式。 |
| `--out <file>` | 输出文件。 |
| `--overwrite` | 覆盖已有输出文件。默认不覆盖。 |

diff 和 report 参数：

| 参数 | 说明 |
| --- | --- |
| `--before <file>` | 变更前快照文件。 |
| `--after <file>` | 变更后快照文件。 |
| `--format json\|markdown` | diff 输出格式。 |
| `--format markdown\|html` | report 输出格式。 |
| `--sql-index <file>` | `scan-sql --index-out` 生成的 SQL 使用索引。 |
| `--risk-only` | 仅 diff：只保留有风险的变化。 |
| `--summary-only` | 输出更短的 diff 或报告。 |
| `--title <title>` | 报告标题。 |
| `--out <file>` | 输出文件。 |
| `--overwrite` | 覆盖已有输出文件。默认不覆盖。 |

元数据命令只读取元数据和本地文件，不执行数据库变更，也不输出可直接执行的 DDL。

## 扫描项目 SQL

扫描本地项目中的 SQL 片段，默认只输出报告，不修改文件：

```bash
ob-mcp scan-sql --path src --path mapper --ignore generated --index-out snapshots/sql-index.json --format json
```

源码仓库内也可以运行：

```bash
npm run build
node dist/index.js scan-sql --path src --extensions sql,xml,ts,js,java --format text
```

扫描范围包括 `.sql`、`.xml`、`.ts`、`.js`、`.java`。命令会报告文件位置、SQL 类型、粗略表引用、只读候选状态、`SELECT *`、缺少分页、写入语句和动态 SQL 提示。需要数据库级表字段校验时，把报告中的 SQL 交给 `ob_validate_sql_snippet`。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--path <path>` | 扫描路径，可重复传入。默认当前目录。 |
| `--ignore <pattern>` | 忽略路径或 glob，可重复传入。默认忽略 `.git`、`node_modules`、`dist`、`build`、`coverage`、`.next`、`target`。 |
| `--extensions <list>` | 扫描扩展名列表，例如 `sql,xml,ts,js,java`。 |
| `--max-files <n>` | 最多扫描文件数。默认 `500`。 |
| `--max-bytes <n>` | 单文件最大读取字节数。默认 `524288`。 |
| `--format json\|text` | 输出格式。默认 `json`。 |
| `--fail-on-risk` | 发现风险片段时返回非 0 退出码，适合本地检查或 CI。 |
| `--index-out <file>` | 写出静态 SQL 使用索引 JSON，用于元数据影响分析。 |
| `--index-overwrite` | 覆盖已有 SQL 使用索引文件。默认不覆盖。 |

`scan-sql` 不连接数据库，不执行 SQL，不写业务文件。它用于快速定位项目里的 SQL 片段；最终执行前仍应走 MCP 只读策略、元数据校验和查询预览。
