# OceanBase MCP v1.1.0

v1.1.0 adds metadata change analysis for local OceanBase development. It helps OpenCode and developers capture metadata snapshots, compare iteration changes, map those changes to project SQL usage, and generate review reports. The server remains strictly read-only.

## 新增能力

- 元数据快照：`ob_capture_metadata_snapshot` 和 `ob-mcp metadata snapshot` 采集表、字段、索引、约束、分区、关系、统计信息、注释和 Oracle 对象元数据。
- 快照对比：`ob_compare_metadata_snapshots` 和 `ob-mcp metadata diff` 输出结构化 diff、风险等级和 Markdown 摘要。
- SQL 使用索引：`ob-mcp scan-sql --index-out` 为项目 SQL 生成静态索引。
- SQL 使用查询：`ob_find_sql_usages` 按表、字段或业务词查找项目 SQL 引用。
- 影响分析：`ob_analyze_metadata_impact` 和 `ob_analyze_change_sql_impact` 汇总受影响对象、SQL、文件、关系和风险证据。
- 变更报告：`ob_generate_metadata_change_report` 和 `ob-mcp metadata report` 输出 Markdown 或简版 HTML。
- 关系路径：`ob_explain_relationship` 增加有限深度 relationship path，显示路径表、关系数、confidence 和 evidence。
- OpenCode 工作流：Agent/Skill 增加“迭代开始快照 -> SQL index -> 迭代结束快照 -> diff -> impact -> report”的流程。

## 验证要求

- MySQL 模式 smoke test 覆盖元数据快照、快照对比、影响分析、SQL 使用索引、SQL 使用查询和变更报告。
- Oracle 模式 smoke test 覆盖元数据快照、快照对比、Oracle 对象 diff、影响分析、SQL 使用索引和变更报告。
- `npm test`、`npm run docs:check`、`npm audit --omit=dev --audit-level=moderate`、`npm pack --dry-run` 和 Docker build 通过。

## 离线构建

Release 包含源码归档：

```bash
tar -xzf ob-mcp-1.1.0-source.tar.gz
cd ob-mcp-1.1.0
npm ci
npm run build
npm run start
```

源码归档不包含 `node_modules` 和 `dist`。私有 npm 制品库需要提供 `package-lock.json` 中锁定的依赖。

## 生产注意事项

- 建议数据库账号仍使用只读权限；MCP 会继续拦截写入、DDL、DCL、过程调用、序列 `NEXTVAL`、锁和危险函数。
- 元数据变更报告只输出风险、证据和评审建议，不输出可直接执行的 DDL。
- 大 schema 建议使用 `--schema`、`--table-pattern`、`--max-tables`、`--max-columns-per-table`、`--max-objects` 和 `--max-relationships` 控制范围。
- SQL 使用索引来自静态扫描。动态 SQL 会标记为不确定，需要人工复核。
