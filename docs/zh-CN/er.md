# ER 图

[English](../en/er.md) | [返回](README.md)

ER 图能力基于可见元数据和关系证据生成，不会凭空补关系。关系来源包括外键、约束、唯一键、索引和保守字段命名推断；推断关系必须返回 evidence 和 confidence。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `ob_generate_er_diagram` | 生成 Mermaid 和 JSON ER 元数据，支持 schema、table、业务词、深度和表数量限制。 |
| `ob_generate_er_html` | 生成自包含 HTML ER 图，支持 static、interactive、compact、detailed。 |
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

大图建议使用 CLI 导出到本地文件，再用浏览器查看。

交互版 HTML 适合日常开发排查：左侧是表索引，中间是 ER 画布，右侧显示选中表的字段、主键、索引和直接关系；下方关系表保留外键或推断依据。点击表名或画布节点会聚焦上下游关系，不会把低置信度推断关系当作真实外键。

## CLI 导出

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

默认不会覆盖已有文件。需要覆盖时显式传入 `--overwrite`。

## 使用建议

- 先缩小 schema、table 或业务词范围。
- 优先查看 `ob_find_related_tables` 和 `ob_explain_relationship` 的证据。
- 不要把低置信度推断关系当作真实外键。
- Oracle 模式注意对象名大小写和 schema 范围。
