# 元数据变更流程示例

[English](metadata-change-workflow.en.md) | [返回](README.zh-CN.md)

这个示例用于在迭代开始和结束各采集一次元数据快照，扫描项目 SQL，比较快照，并生成评审报告。流程只读，不执行数据库变更。

## MySQL 模式

```bash
mkdir -p snapshots

ob-mcp metadata snapshot \
  --schema biz_test \
  --max-tables 100 \
  --max-columns-per-table 120 \
  --out snapshots/mysql-before.json

ob-mcp scan-sql \
  --path src \
  --path mapper \
  --extensions sql,xml,ts,js,java \
  --index-out snapshots/sql-index.json \
  --format text

ob-mcp metadata snapshot \
  --schema biz_test \
  --max-tables 100 \
  --max-columns-per-table 120 \
  --out snapshots/mysql-after.json

ob-mcp metadata diff \
  --before snapshots/mysql-before.json \
  --after snapshots/mysql-after.json \
  --format markdown \
  --out snapshots/mysql-diff.md

ob-mcp metadata report \
  --before snapshots/mysql-before.json \
  --after snapshots/mysql-after.json \
  --sql-index snapshots/sql-index.json \
  --format markdown \
  --title "迭代元数据评审" \
  --out snapshots/mysql-report.md
```

## Oracle 模式

```bash
mkdir -p snapshots

OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot \
  --schema OB_USER \
  --include-oracle-objects \
  --max-objects 200 \
  --out snapshots/oracle-before.json

OB_COMPATIBILITY=oracle \
ob-mcp metadata snapshot \
  --schema OB_USER \
  --include-oracle-objects \
  --max-objects 200 \
  --out snapshots/oracle-after.json

ob-mcp metadata diff \
  --before snapshots/oracle-before.json \
  --after snapshots/oracle-after.json \
  --format markdown \
  --out snapshots/oracle-diff.md

ob-mcp metadata report \
  --before snapshots/oracle-before.json \
  --after snapshots/oracle-after.json \
  --format html \
  --title "Oracle 元数据评审" \
  --out snapshots/oracle-report.html
```

## OpenCode 提示词

```text
使用 oceanbase MCP 做一次迭代元数据评审。
如果我提供快照，就使用已有快照；否则采集变更前和变更后快照。
扫描 src 和 mapper 生成 SQL 使用索引。
对比快照，分析 SQL 影响，然后生成 Markdown 报告。
只输出有证据的风险，不要输出可执行 DDL。
```

只有确认要替换已有本地文件时，才使用 `--overwrite` 或 `--index-overwrite`。
