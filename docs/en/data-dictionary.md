# Data Dictionary And Documentation

[中文](../zh-CN/data-dictionary.md) | [Back](README.md)

Data dictionary and documentation tools help developers understand database structure. Output is based on visible metadata, relationship evidence, and an optional business glossary. It does not include sensitive sample values or execute target SQL.

## Data Dictionary

| Tool | Purpose |
| --- | --- |
| `ob_get_database_dictionary` | Generates bounded JSON or Markdown data dictionaries from visible metadata. |
| `ob_generate_data_dictionary` | Generates JSON, Markdown, or simple HTML data dictionaries. |
| `ob_search_business_glossary` | Searches visible business-term mappings to schemas, tables, and columns. |
| `ob_find_tables_by_business_term` | Finds candidate tables for a business term with evidence, confidence, and related-table summaries. |

The business glossary is only used for search and hints. It does not grant additional database access. Results are still filtered by profile, schema, table, and column policy.

## Documentation Generation

| Tool | Purpose |
| --- | --- |
| `ob_generate_table_doc` | Generates Markdown or JSON documentation for one table. |
| `ob_generate_schema_doc` | Generates schema-level Markdown or JSON documentation. |
| `ob_generate_query_doc` | Documents SQL snippet tables, fields, filters, ordering, pagination, and risk. |
| `ob_generate_onboarding_doc` | Generates onboarding documentation with core tables, relationships, and query entry points. |

Documentation tools enforce table-count, column-count, and response-size limits. Inferred content is labeled with evidence or limitations and is not presented as fact.

## Business Glossary Example

```json
{
  "terms": [
    {
      "term": "orders",
      "targets": [
        { "schema": "biz_test", "table": "orders" },
        { "schema": "biz_test", "table": "order_items" }
      ]
    }
  ]
}
```

Set the file path with `OB_BUSINESS_GLOSSARY_FILE`. The file only affects search ranking and hints; it does not change database access scope.
