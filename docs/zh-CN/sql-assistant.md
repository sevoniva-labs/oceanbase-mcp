# SQL 辅助

[English](../en/sql-assistant.md) | [返回](README.md)

SQL 辅助能力用于本地开发，不替代人工确认。所有工具只生成、检查或解释只读 SQL；真正查数仍必须经过 MCP 的只读策略、权限、行数、输出大小、超时、审计和脱敏控制。

## 推荐流程

1. 使用 `ob_search_everything`、`ob_find_tables_by_business_term` 或 `ob_get_schema_map` 找到候选表。
2. 使用 `ob_get_table_context`、`ob_find_columns` 或 `ob_get_table_summary` 确认字段、索引、关系和样例限制。
3. 使用 `ob_prepare_query` 或 `ob_build_select` 生成只读 SQL。
4. 使用 `ob_lint_sql`、`ob_query_preview` 或 `ob_policy_explain` 检查风险。
5. 使用 `ob_query_page` 或查询会话分页查看结果。

不要猜表名、字段名或关系。候选结果必须带 evidence 和 confidence，无法确认时应继续查元数据。

## 生成和检查 SQL

| 工具 | 用途 |
| --- | --- |
| `ob_prepare_query` | 根据自然语言问题、业务词和可见元数据准备候选表、字段、SQL 草稿和风险预览。 |
| `ob_build_select` | 用结构化参数生成 SELECT，表和字段必须先通过元数据校验。 |
| `ob_lint_sql` | 检查只读策略、方言、分页、排序、敏感字段和执行计划风险。 |
| `ob_rewrite_sql` | 将 SELECT/WITH 改写为更安全的只读形式，并说明改写原因。 |
| `ob_convert_sql_dialect` | 在 OceanBase MySQL/Oracle 模式之间转换只读查询，并标明限制。 |
| `ob_explain_error` | 根据策略和可见元数据解释 SQL 错误，不执行 SQL。 |
| `ob_generate_query_examples` | 基于表上下文生成常用只读查询示例。 |

`ob_build_select` 适合明确表、字段和过滤条件的场景。`ob_prepare_query` 适合用户只描述业务问题、需要先找表的场景。

参数化 SQL 使用 `?` 位置占位符。Oracle 模式下，传入 `params` 数组时也兼容简单的 `:name` 绑定占位符；生成 MCP 调用时仍建议优先使用 `?`，避免歧义。

## 查询会话

查询会话是内存上下文，不持久化敏感数据：

- `ob_start_query_session` 记录本轮确认过的表、字段、SQL、分页和警告。
- `ob_query_next_page`、`ob_query_prev_page` 基于会话翻页，继续执行只读策略和行数限制。
- `ob_query_refine` 基于已有上下文追加字段、条件、排序或分页，只返回新 SQL 和风险预览。
- `ob_close_query_session` 关闭会话。

如果查询没有稳定排序字段，分页工具会提示结果顺序不稳定。

## 项目 SQL

CLI `ob-mcp scan-sql` 用于扫描项目中的 `.sql`、`.xml`、`.ts`、`.js`、`.java` 文件，默认只报告，不修改代码。需要数据库级校验时，把扫描出的 SQL 交给：

- `ob_validate_sql_snippet`
- `ob_explain_project_query`
- `ob_find_unknown_columns_in_sql`
- `ob_generate_mapper_context`

这些工具不会执行目标 SQL，也不会修改业务文件。

从 v1.1.0 起，`scan-sql` 还可以写出 SQL 使用索引：

```bash
ob-mcp scan-sql --path src --path mapper --index-out snapshots/sql-index.json --format text
```

使用 `ob_find_sql_usages` 可以按表、字段或业务词查询这个索引。元数据 diff 需要和项目 SQL 引用一起分析时，使用 `ob_analyze_change_sql_impact`。这两个工具都基于静态证据，不执行项目 SQL。
