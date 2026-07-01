# 数据字典与文档生成

[English](../en/data-dictionary.md) | [返回](README.md)

数据字典和文档生成能力用于帮助开发者理解库表结构。输出来自可见元数据、关系证据和可选业务字典，不包含敏感样例值，也不会执行目标查询。

## 数据字典

| 工具 | 用途 |
| --- | --- |
| `ob_get_database_dictionary` | 基于可见元数据生成受限 JSON 或 Markdown 数据字典。 |
| `ob_generate_data_dictionary` | 生成 JSON、Markdown 或简版 HTML 数据字典。 |
| `ob_search_business_glossary` | 搜索业务词到 schema/table/column 的可见映射。 |
| `ob_find_tables_by_business_term` | 按业务词找候选表，并返回依据、置信度和关联表摘要。 |

业务字典只用于搜索和提示，不授予额外数据库权限。所有结果仍受 profile、schema、table、column 权限过滤。

## 文档生成

| 工具 | 用途 |
| --- | --- |
| `ob_generate_table_doc` | 生成单表 Markdown 或 JSON 文档。 |
| `ob_generate_schema_doc` | 生成 schema 级 Markdown 或 JSON 文档。 |
| `ob_generate_query_doc` | 说明 SQL 片段涉及的表、字段、过滤、排序、分页和风险。 |
| `ob_generate_onboarding_doc` | 生成新开发者入门文档，包含核心表、关系和查询入口。 |

文档生成工具都有表数量、字段数量和输出大小限制。内容中如有推断，会标明 evidence 或限制，不写成确定事实。

## 业务字典示例

```json
{
  "terms": [
    {
      "term": "订单",
      "targets": [
        { "schema": "biz_test", "table": "orders" },
        { "schema": "biz_test", "table": "order_items" }
      ]
    }
  ]
}
```

配置路径由 `OB_BUSINESS_GLOSSARY_FILE` 指定。配置文件只影响搜索排序和提示，不改变数据库访问范围。
