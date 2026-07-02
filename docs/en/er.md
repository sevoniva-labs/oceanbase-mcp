# ER Diagrams

[中文](../zh-CN/er.md) | [Back](README.md)

ER diagrams are generated from visible metadata and relationship evidence. The server does not invent relationships. Evidence can come from foreign keys, constraints, unique keys, indexes, and conservative column-name inference. Inferred relationships include evidence and confidence.

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `ob_generate_er_diagram` | Generates Mermaid and JSON ER metadata with schema, table, business-term, depth, and table-count limits. |
| `ob_generate_er_html` | Generates self-contained HTML ER diagrams in static, interactive, compact, or detailed form. Large schema scopes return export guidance instead of oversized inline HTML. |
| `ob_plan_er_export` | Estimates table, column, and relationship scale, then plans local cluster ER export commands. |
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

The interactive HTML format is intended for daily development work. It uses a self-contained graph canvas with stable internal IDs, so Chinese identifiers, special characters, and Oracle uppercase object names do not become DOM IDs. The left panel lists tables and filters, the center canvas supports zoom, drag, fit, reset, and neighborhood focus, and the right panel shows table details or relationship evidence. Relationship counts update with filters. Low-confidence possible relationships are hidden by default and can be enabled from the relation filters.

For large schemas, use directory export. The exported directory separates the model into an overview, cluster diagrams, table pages, and metadata JSON. Cluster pages render readable local diagrams. Cross-cluster relationships are kept in `metadata/relationships.json`, `overview.html`, and table pages.

## CLI Export

```bash
ob-mcp export-er --schema biz_test --table orders --format interactive --out docs/orders-er.html
```

Cluster export for larger schemas:

```bash
ob-mcp export-er --schema biz_test --format interactive --strategy connected-components --out-dir docs/er --chunk-size 25
```

Existing files are not overwritten by default. Pass `--overwrite` explicitly when needed.

`--out-dir` writes:

- `index.html`
- `overview.html`
- `clusters/cluster-001.html`
- `tables/*.html`
- `metadata/graph.json`
- `metadata/diagnostics.json`
- `metadata/er-summary.json`
- `metadata/relationships.json`
- `metadata/warnings.json`

For directory exports, `metadata/relationships.json` keeps the planned relationship index, including cross-cluster relationships, confidence, field mapping, and evidence. `metadata/graph.json` collects graph data from generated cluster HTML files. `metadata/diagnostics.json` groups export diagnostics without filling the main page with repeated warnings.

`ob_plan_er_export` is metadata-only and lightweight. It returns `estimatedTableCount`, `estimatedColumnCount`, `estimatedRelationshipCount`, large-table estimates, `suggestedStrategy`, `suggestedMaxTablesPerFile`, risks, warnings, relationship index, and cluster commands. Supported strategies are `single`, `connected-components`, `table-prefix`, `business-term`, `manual`, and `window`.

## Usage Notes

- Start with a narrow schema, table, or business-term scope.
- For schema-wide ER work, call `ob_plan_er_export` before generating HTML.
- Schema-level `ob_generate_er_html` skips large inline rendering and returns export guidance when the selected scope is too broad.
- For large schemas, prefer `ob-mcp export-er --out-dir` and pick a strategy before raising limits.
- Use `relationshipMode=foreign_key` by default. Use `inferred` only for a small, explicit scope.
- Review evidence from `ob_find_related_tables` and `ob_explain_relationship`.
- Do not treat low-confidence inferred relationships as real foreign keys.
- In Oracle mode, pay attention to object-name case and schema scope.
