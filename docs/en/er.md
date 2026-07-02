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

For larger diagrams, use `ob_plan_er_export` first, then export a local directory with the CLI and open `index.html` in a browser.

The interactive HTML format is intended for daily development work. The left panel lists tables, the center canvas shows the ER model, and the right panel starts with a schema overview. Selecting a table or diagram node focuses upstream and downstream relationships, scrolls the selected table into view, and shows columns, primary keys, indexes, and direct relationships. Large diagrams use a multi-column overview layout and show key fields first; relationship evidence remains visible in the relationship table.

## CLI Export

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

Chunked export for larger schemas:

```bash
ob-mcp export-er --schema biz_test --format interactive --out-dir docs/er --chunk-size 25
```

Existing files are not overwritten by default. Pass `--overwrite` explicitly when needed.

`--out-dir` writes:

- `index.html`
- `overview.html`
- `chunks/*.html`
- `tables/*.html`
- `metadata/er-summary.json`
- `metadata/relationships.json`
- `metadata/warnings.json`

For chunked exports, `relationshipCount` in `metadata/relationships.json` is the number of relationships rendered inside chunk HTML files. `plannedRelationshipCount` records the planning-stage estimate or configured relationship limit. Cross-chunk relationships may need a smaller manual scope when they must be inspected in one diagram.

## Usage Notes

- Start with a narrow schema, table, or business-term scope.
- For schema-wide ER work, call `ob_plan_er_export` before generating HTML.
- Use `relationshipMode=foreign_key` by default. Use `inferred` only for a small, explicit scope.
- Review evidence from `ob_find_related_tables` and `ob_explain_relationship`.
- Do not treat low-confidence inferred relationships as real foreign keys.
- In Oracle mode, pay attention to object-name case and schema scope.
