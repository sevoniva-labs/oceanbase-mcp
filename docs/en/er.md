# ER Diagrams

[中文](../zh-CN/er.md) | [Back](README.md)

ER diagrams are generated from visible metadata and relationship evidence. The server does not invent relationships. Evidence can come from foreign keys, constraints, unique keys, indexes, and conservative column-name inference. Inferred relationships include evidence and confidence.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `ob_generate_er_diagram` | Generates Mermaid and JSON ER metadata with schema, table, business-term, depth, and table-count limits. |
| `ob_generate_er_html` | Generates self-contained HTML ER diagrams in static, interactive, compact, or detailed form. |
| `ob_plan_er_export` | Plans chunked local ER HTML export commands for large schemas to avoid oversized inline MCP responses. |
| `ob_generate_entity_diagram` | Generates a local entity diagram from a business term or table, with Mermaid, JSON, HTML, and relationship evidence. |
| `ob_explain_relationship` | Explains field, constraint, naming evidence, and confidence between two tables. |
| `ob_generate_er_document` | Generates Markdown, PlantUML, and DOT model documentation. |

All outputs are controlled by permission, table-count, column-count, and response-size limits.

## HTML Formats

| Format | Use case |
| --- | --- |
| `html-static` | Single-file HTML with tables, columns, and relationship lists. |
| `html-interactive` | Single-file interactive diagram with table search, zoom, drag, auto-fit, table details, and relationship highlighting. |
| `html-compact` | Shows only tables and primary relationships for larger schemas. |
| `html-detailed` | Shows columns, primary keys, foreign keys, indexes, and comments. |

For larger diagrams, export a local file with the CLI and open it in a browser.

The interactive HTML format is intended for daily development work. The left panel lists tables, the center canvas shows the ER model, and the right panel shows columns, primary keys, indexes, and direct relationships for the selected table. The relationship table keeps the foreign-key or inference evidence visible. Selecting a table or diagram node focuses upstream and downstream relationships without treating low-confidence inference as a real foreign key.

## CLI Export

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

Chunked export for larger schemas:

```bash
ob-mcp export-er --schema biz_test --format interactive --out-dir docs/er --chunk-size 25
```

Existing files are not overwritten by default. Pass `--overwrite` explicitly when needed.

## Usage Notes

- Start with a narrow schema, table, or business-term scope.
- Review evidence from `ob_find_related_tables` and `ob_explain_relationship`.
- Do not treat low-confidence inferred relationships as real foreign keys.
- In Oracle mode, pay attention to object-name case and schema scope.
