# ER 图

[English](../en/er.md) | [返回](README.md)

ER 图能力基于可见元数据和关系证据生成，不会凭空补关系。关系来源包括外键、约束、唯一键、索引和保守字段命名推断；推断关系必须返回 evidence 和 confidence。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `ob_generate_er_diagram` | 生成 Mermaid 和 JSON ER 元数据，支持 schema、table、业务词、深度和表数量限制。 |
| `ob_generate_er_html` | 生成自包含 HTML ER 图，支持 static、interactive、compact、detailed；大范围 schema 会返回导出建议，不返回超大 inline HTML。 |
| `ob_plan_er_export` | 轻量估算表、字段和关系规模，并规划本地 cluster ER 导出命令。 |
| `ob_generate_entity_diagram` | 围绕业务词或表名生成局部实体图，返回 Mermaid、JSON、HTML 和关系依据。 |
| `ob_explain_relationship` | 解释两张表之间的字段依据、约束依据、命名依据和置信度。 |
| `ob_generate_er_document` | 生成 Markdown、PlantUML 和 DOT 格式的模型说明。 |

所有输出都受权限、表数量、字段数量和响应大小限制控制。

## HTML 格式

| 格式 | 适用场景 |
| --- | --- |
| `html-static` | 单文件 HTML，包含表、字段和关系清单。 |
| `html-interactive` | 单文件交互图，支持表搜索、缩放、拖拽、自动适配、表详情和关系高亮。 |
| `html-compact` | 只显示表和主关系，适合表较多的 schema。 |
| `html-detailed` | 显示字段、主键、外键、索引和字段注释。 |

大图建议先使用 `ob_plan_er_export` 规划，再用 CLI 导出本地目录，并在浏览器打开 `index.html`。

交互版 HTML 适合日常开发排查：它使用自包含图画布和稳定内部 ID，中文名、特殊字符、Oracle 大写对象名不会直接变成 DOM ID。左侧是表清单和筛选，中间画布支持缩放、拖拽、适配、重置和上下游聚焦，右侧显示表详情或关系证据。关系数量会随筛选实时变化。低置信度 possible 关系默认隐藏，需要时可在关系筛选里开启。

大 schema 建议使用目录导出。导出目录会拆成 overview、cluster 图、单表页面和元数据 JSON。cluster 页面用于查看可读的局部图；跨 cluster 关系保留在 `metadata/relationships.json`、`overview.html` 和单表页面里。

## CLI 导出

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

大 schema cluster 导出：

```bash
ob-mcp export-er --schema biz_test --format interactive --strategy connected-components --out-dir docs/er --chunk-size 25
```

默认不会覆盖已有文件。需要覆盖时显式传入 `--overwrite`。

`--out-dir` 会写出：

- `index.html`
- `overview.html`
- `clusters/cluster-001.html`
- `tables/*.html`
- `metadata/graph.json`
- `metadata/diagnostics.json`
- `metadata/er-summary.json`
- `metadata/relationships.json`
- `metadata/warnings.json`

目录导出时，`metadata/relationships.json` 保存规划阶段的完整关系索引，包括跨 cluster 关系、置信度、字段映射和证据。`metadata/graph.json` 汇总已生成 cluster HTML 中的图数据。`metadata/diagnostics.json` 汇总诊断信息，避免主页面出现大量重复提示。

`ob_plan_er_export` 只读取元数据，返回 `estimatedTableCount`、`estimatedColumnCount`、`estimatedRelationshipCount`、大表估算、`suggestedStrategy`、`suggestedMaxTablesPerFile`、风险、warnings、关系索引和 cluster 命令。支持策略：`single`、`connected-components`、`table-prefix`、`business-term`、`manual`、`window`。

## 使用建议

- 先缩小 schema、table 或业务词范围。
- schema 级 ER 先调用 `ob_plan_er_export`，再决定是否目录导出。
- schema 级 `ob_generate_er_html` 范围过大时会跳过 inline 渲染，并返回导出建议。
- 大 schema 优先使用 `ob-mcp export-er --out-dir`，先选 cluster 策略，再考虑调大限制。
- 默认使用 `relationshipMode=foreign_key`。只有明确的小范围分析才使用 `inferred`。
- 优先查看 `ob_find_related_tables` 和 `ob_explain_relationship` 的证据。
- 不要把低置信度推断关系当作真实外键。
- Oracle 模式注意对象名大小写和 schema 范围。
