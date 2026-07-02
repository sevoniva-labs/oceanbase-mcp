# 元数据变更分析

[English](../en/metadata-change.md) | [返回](README.md)

OceanBase MCP 可以采集纯元数据快照、对比迭代前后变化、查找项目 SQL 使用位置，并生成评审报告。整个流程只读：只读取 OceanBase 元数据和本地项目文件，不执行 schema 变更，也不修改业务代码。

## 使用流程

```bash
mkdir -p snapshots

ob-mcp metadata snapshot \
  --schema biz_test \
  --out snapshots/before.json

ob-mcp scan-sql \
  --path src \
  --path mapper \
  --index-out snapshots/sql-index.json \
  --format text

ob-mcp metadata snapshot \
  --schema biz_test \
  --out snapshots/after.json

ob-mcp metadata diff \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --format markdown \
  --out snapshots/diff.md

ob-mcp metadata report \
  --before snapshots/before.json \
  --after snapshots/after.json \
  --sql-index snapshots/sql-index.json \
  --format markdown \
  --out snapshots/report.md
```

只有确认要覆盖本地文件时，才使用 `--overwrite` 或 `--index-overwrite`。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `ob_capture_metadata_snapshot` | 采集 MySQL 或 Oracle 模式下的受限元数据快照。 |
| `ob_compare_metadata_snapshots` | 对比两份快照，返回新增、删除和修改的元数据对象。 |
| `ob_find_sql_usages` | 从静态 SQL 使用索引中查找表、字段或业务词引用。 |
| `ob_analyze_change_sql_impact` | 基于元数据 diff 和 SQL 使用索引分析 SQL 影响。 |
| `ob_analyze_metadata_impact` | 基于 diff 证据汇总上下游、SQL、关系和业务词影响。 |
| `ob_generate_metadata_change_report` | 生成 Markdown 或简版 HTML 评审报告。 |

## 快照范围

快照包含 schema、表、字段、索引、约束、分区、关系、表统计信息、注释，以及可见的 Oracle 对象元数据。快照不包含样例行，也不读取业务数据值。

常用限制：

| 参数 | 说明 |
| --- | --- |
| `--schema` | 限定采集的 schema。 |
| `--table-pattern` | 按表名模式限定范围。 |
| `--max-tables` | 限制表数量。 |
| `--max-columns-per-table` | 限制单表字段数量。 |
| `--max-objects` | 限制 Oracle 对象数量。 |
| `--max-relationships` | 限制关系证据数量。 |
| `--no-relationships` | 跳过关系发现。 |
| `--no-oracle-objects` | 跳过 Oracle 对象元数据。 |

大 schema 应使用 `--schema`、`--table-pattern` 和各类 max 限制。快照因限制被截断时，会在输出中写入 warnings。

## SQL 使用索引

`ob-mcp scan-sql` 会扫描 `.sql`、`.xml`、`.ts`、`.js` 和 `.java` 文件，输出 SQL 类型、表、字段、动态 SQL 信号、MyBatis `${}` / `#{}` 提示、只读候选状态、分页风险和方言提示。

SQL 使用索引只做静态分析，不连接 OceanBase，不修改文件。

## 报告内容

报告包含：

- 快照范围和摘要。
- 新增、删除和修改对象。
- 破坏性变更。
- 表、字段、索引、约束、分区和 Oracle 对象变化。
- 带文件和行号证据的 SQL 使用影响。
- 关系和业务字典证据。
- 评审检查项和已知限制。

报告不会输出可直接执行的 `ALTER`、`CREATE`、`DROP`、`GRANT` 或索引 DDL。

## OpenCode 使用方式

要求 OpenCode 按以下顺序执行：

1. 采集迭代开始快照。
2. 扫描项目 SQL 使用索引。
3. 采集迭代结束快照。
4. 对比快照。
5. 结合 SQL 索引分析影响。
6. 生成 Markdown 或 HTML 报告。
7. 汇总证据、风险和需要人工确认的事项。

OpenCode 不应推断不存在的关系或 SQL 使用位置。结论必须来自快照 diff、SQL 使用索引、关系元数据或业务字典。

## MySQL 和 Oracle 注意事项

- MySQL 模式读取 `information_schema` 元数据。
- Oracle 模式根据 schema 范围读取 `USER_*` 或 `ALL_*` 元数据。
- Oracle 对象 diff 可覆盖 view、sequence、synonym、procedure、function 和 package。
- 对象大小写遵循当前兼容模式。

## 安全边界

元数据变更分析只提供建议。它可以指出删除字段可能影响某个 mapper 或报表，但不能输出可直接执行的数据库变更 SQL。报告应作为评审材料，数据库变更仍走独立流程。
