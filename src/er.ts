import type { CompatibilityMode } from "./config.js";
import type { TableRelationship } from "./db.js";

export interface ErColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
  comment?: string;
  indexed?: boolean;
  indexNames?: string[];
}

export interface ErEntity {
  schema?: string;
  table: string;
  columns: ErColumn[];
}

export interface ErDiagram {
  mode: CompatibilityMode;
  entities: ErEntity[];
  relationships: TableRelationship[];
  mermaid: string;
}

export type ErHtmlFormat = "html-static" | "html-interactive" | "html-compact" | "html-detailed";

export interface ErHtmlOptions {
  title?: string;
  warnings?: string[];
  generatedAt?: string;
  maxColumnsPerEntity?: number;
  format?: ErHtmlFormat;
}

export interface ErDocumentOptions {
  title?: string;
  warnings?: string[];
}

export function buildErDiagram(
  mode: CompatibilityMode,
  entities: ErEntity[],
  relationships: TableRelationship[]
): ErDiagram {
  return {
    mode,
    entities,
    relationships,
    mermaid: renderMermaidEr(entities, relationships)
  };
}

export function renderErHtml(diagram: ErDiagram, options: ErHtmlOptions = {}): string {
  const title = options.title ?? "OceanBase ER Diagram";
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const format = options.format ?? "html-static";
  const maxColumns = Math.max(0, Math.min(options.maxColumnsPerEntity ?? defaultMaxColumnsForFormat(format), 50));
  const svg = renderSvgEr(diagram.entities, diagram.relationships, maxColumns);
  const metadataJson = JSON.stringify({
    mode: diagram.mode,
    entities: diagram.entities,
    relationships: diagram.relationships
  }, null, 2);
  const warnings = options.warnings ?? [];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #18202a;
      --muted: #5d6978;
      --line: #c8d0da;
      --accent: #136f63;
      --accent-soft: #e7f3f1;
      --warn: #8a5a00;
      --warn-soft: #fff4d6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 24px 32px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    .meta { color: var(--muted); display: flex; flex-wrap: wrap; gap: 12px; }
    main { padding: 24px 32px 40px; }
    section { margin-bottom: 24px; }
    .canvas {
      overflow: auto;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      padding: 16px;
    }
    .warnings {
      border: 1px solid #f0cf84;
      background: var(--warn-soft);
      color: var(--warn);
      border-radius: 6px;
      padding: 12px 14px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
    }
    th, td { padding: 9px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef2f5; font-weight: 650; }
    tr:last-child td { border-bottom: 0; }
    details {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    summary { cursor: pointer; font-weight: 650; }
    pre {
      overflow: auto;
      white-space: pre;
      background: #111827;
      color: #e5e7eb;
      border-radius: 4px;
      padding: 12px;
    }
    .entity-box { fill: #ffffff; stroke: #8fa1b3; }
    .entity-header { fill: var(--accent-soft); stroke: #8fa1b3; }
    .entity-name { fill: var(--text); font-weight: 650; font-size: 13px; }
    .column-text { fill: #2b3645; font-size: 12px; }
    .column-muted { fill: var(--muted); font-size: 11px; }
    .rel-line { stroke: var(--accent); stroke-width: 1.5; fill: none; opacity: 0.75; }
    .rel-label { fill: var(--accent); font-size: 11px; }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .controls input {
      min-width: 240px;
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-radius: 4px;
      font: inherit;
    }
    .controls button {
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
      cursor: pointer;
      font: inherit;
    }
    .svg-wrap { transform-origin: 0 0; }
    .dimmed { opacity: 0.18; }
    .match .entity-box { stroke: var(--accent); stroke-width: 2; }
    .entity-details h3 { margin: 18px 0 8px; font-size: 16px; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <span>Mode: ${escapeHtml(diagram.mode)}</span>
      <span>Format: ${escapeHtml(format)}</span>
      <span>Tables: ${diagram.entities.length}</span>
      <span>Relationships: ${diagram.relationships.length}</span>
      <span>Generated: ${escapeHtml(generatedAt)}</span>
    </div>
  </header>
  <main>
    ${warnings.length > 0 ? `<section class="warnings">${warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join("")}</section>` : ""}
    <section class="canvas">
      ${format === "html-interactive" ? renderInteractiveControls() : ""}
      <div class="svg-wrap">${svg}</div>
    </section>
    ${format === "html-detailed" || format === "html-interactive" ? `<section class="entity-details">${renderEntityDetails(diagram.entities)}</section>` : ""}
    <section>
      <h2>Relationships</h2>
      ${renderRelationshipTable(diagram.relationships)}
    </section>
    ${format === "html-compact" ? "" : `<section>
      <details>
        <summary>Mermaid Source</summary>
        <pre>${escapeHtml(diagram.mermaid)}</pre>
      </details>
      <details>
        <summary>JSON Metadata</summary>
        <pre>${escapeHtml(metadataJson)}</pre>
      </details>
    </section>`}
  </main>
  ${format === "html-interactive" ? renderInteractiveScript() : ""}
</body>
</html>`;
}

export function renderErMarkdown(diagram: ErDiagram, options: ErDocumentOptions = {}): string {
  const title = options.title ?? "OceanBase ER Model";
  const lines = [
    `# ${title}`,
    "",
    `Mode: ${diagram.mode}`,
    `Tables: ${diagram.entities.length}`,
    `Relationships: ${diagram.relationships.length}`,
    ""
  ];
  if (options.warnings && options.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const warning of options.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  lines.push("## Tables", "");
  for (const entity of diagram.entities) {
    lines.push(`### ${tableLabel(entity.schema, entity.table)}`, "");
    lines.push("| Column | Type | PK | Nullable | Index | Comment |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const column of entity.columns) {
      lines.push([
        "",
        escapeMarkdown(column.name),
        escapeMarkdown(column.type ?? ""),
        column.primaryKey ? "yes" : "",
        column.nullable === false ? "no" : column.nullable === true ? "yes" : "",
        column.indexed ? escapeMarkdown((column.indexNames ?? []).join(", ")) : "",
        escapeMarkdown(column.comment ?? ""),
        ""
      ].join(" | "));
    }
    lines.push("");
  }
  lines.push("## Relationships", "");
  lines.push("| Source | Target | Type | Confidence | Evidence |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const relation of diagram.relationships) {
    lines.push([
      "",
      escapeMarkdown(`${tableLabel(relation.sourceSchema, relation.sourceTable)}.${relation.sourceColumns.join(",")}`),
      escapeMarkdown(`${tableLabel(relation.targetSchema, relation.targetTable)}.${relation.targetColumns.join(",")}`),
      relation.relationType,
      relation.confidence.toFixed(2),
      escapeMarkdown(relation.evidence.map((item) => item.detail).join(" ")),
      ""
    ].join(" | "));
  }
  if (diagram.relationships.length === 0) {
    lines.push("|  |  |  |  | No visible relationships. |");
  }
  return lines.join("\n");
}

export function renderErPlantUml(diagram: ErDiagram): string {
  const lines = ["@startuml", "hide circle", "skinparam classAttributeIconSize 0"];
  for (const entity of diagram.entities) {
    const alias = plantUmlAlias(entity.schema, entity.table);
    lines.push(`class "${tableLabel(entity.schema, entity.table)}" as ${alias} {`);
    for (const column of entity.columns.slice(0, 50)) {
      const prefix = column.primaryKey ? "*" : column.nullable === false ? "+" : "";
      lines.push(`  ${prefix}${plantUmlText(column.name)} : ${plantUmlText(column.type ?? "string")}`);
    }
    lines.push("}");
  }
  for (const relation of diagram.relationships) {
    const source = plantUmlAlias(relation.sourceSchema, relation.sourceTable);
    const target = plantUmlAlias(relation.targetSchema, relation.targetTable);
    const label = relation.constraintName ?? relation.relationType;
    lines.push(`${target} "1" --> "0..*" ${source} : ${plantUmlText(label)}`);
  }
  lines.push("@enduml");
  return lines.join("\n");
}

export function renderErDot(diagram: ErDiagram): string {
  const lines = [
    "digraph oceanbase_er {",
    "  graph [rankdir=LR];",
    "  node [shape=record, fontname=\"Helvetica\"];",
    "  edge [fontname=\"Helvetica\"];"
  ];
  for (const entity of diagram.entities) {
    const id = dotId(entity.schema, entity.table);
    const columns = entity.columns.slice(0, 20).map((column) => {
      const flags = [column.primaryKey ? "PK" : "", column.nullable === false ? "NN" : ""].filter(Boolean).join(" ");
      return `${dotText(column.name)}${column.type ? `: ${dotText(column.type)}` : ""}${flags ? ` [${flags}]` : ""}`;
    });
    const label = `{${dotText(tableLabel(entity.schema, entity.table))}|${columns.join("\\l")}\\l}`;
    lines.push(`  ${id} [label="${label}"];`);
  }
  for (const relation of diagram.relationships) {
    const source = dotId(relation.sourceSchema, relation.sourceTable);
    const target = dotId(relation.targetSchema, relation.targetTable);
    const label = dotText(relation.constraintName ?? relation.relationType);
    lines.push(`  ${target} -> ${source} [label="${label}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderMermaidEr(entities: ErEntity[], relationships: TableRelationship[]): string {
  const lines = ["erDiagram"];
  const entityIds = new Map<string, string>();
  for (const entity of entities) {
    const id = entityId(entity.schema, entity.table);
    entityIds.set(entityKey(entity.schema, entity.table), id);
    lines.push(`  ${id} {`);
    const columns = entity.columns.slice(0, 50);
    if (columns.length === 0) {
      lines.push("    string metadata");
    } else {
      for (const column of columns) {
        const flags = [column.primaryKey ? "PK" : "", column.nullable === false ? "NOT_NULL" : ""].filter(
          Boolean
        );
        lines.push(
          `    ${mermaidType(column.type)} ${mermaidName(column.name)}${flags.length ? ` ${flags.join(" ")}` : ""}`
        );
      }
    }
    lines.push("  }");
  }

  for (const relationship of relationships) {
    const source = entityIds.get(entityKey(relationship.sourceSchema, relationship.sourceTable));
    const target = entityIds.get(entityKey(relationship.targetSchema, relationship.targetTable));
    if (!source || !target) {
      continue;
    }
    const label = relationship.constraintName ?? relationship.relationType;
    lines.push(`  ${target} ||--o{ ${source} : "${mermaidLabel(label)}"`);
  }

  return lines.join("\n");
}

function entityKey(schema: string | undefined, table: string): string {
  return `${schema ?? ""}.${table}`.toLowerCase();
}

function entityId(schema: string | undefined, table: string): string {
  return mermaidName(schema ? `${schema}_${table}` : table);
}

function mermaidName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
  return normalized || "entity";
}

function mermaidType(value: string | undefined): string {
  if (!value) {
    return "string";
  }
  return mermaidName(value.split(/\s+/)[0] ?? "string");
}

function mermaidLabel(value: string): string {
  return value.replace(/["\\]/g, "").slice(0, 80);
}

function renderSvgEr(entities: ErEntity[], relationships: TableRelationship[], maxColumns: number): string {
  if (entities.length === 0) {
    return `<svg role="img" aria-label="Empty ER diagram" width="640" height="160" viewBox="0 0 640 160" xmlns="http://www.w3.org/2000/svg">
      <text x="24" y="82" class="column-muted">No visible tables matched the selected ER scope.</text>
    </svg>`;
  }

  const boxWidth = 280;
  const headerHeight = 34;
  const rowHeight = 22;
  const gapX = 70;
  const gapY = 70;
  const margin = 36;
  const perRow = Math.max(1, Math.ceil(Math.sqrt(entities.length)));
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  const boxes = entities.map((entity, index) => {
    const visibleColumns = entity.columns.slice(0, maxColumns);
    const hiddenCount = Math.max(0, entity.columns.length - visibleColumns.length);
    const height = headerHeight + rowHeight * (visibleColumns.length + (hiddenCount > 0 ? 1 : 0)) + 10;
    const x = margin + (index % perRow) * (boxWidth + gapX);
    const y = margin + Math.floor(index / perRow) * (height + gapY);
    const position = { x, y, width: boxWidth, height };
    positions.set(entityKey(entity.schema, entity.table), position);
    return { entity, visibleColumns, hiddenCount, position };
  });
  const rows = Math.ceil(entities.length / perRow);
  const maxHeightByRow = new Array(rows).fill(0);
  for (const box of boxes) {
    const row = Math.floor(boxes.indexOf(box) / perRow);
    maxHeightByRow[row] = Math.max(maxHeightByRow[row], box.position.height);
  }
  let currentY = margin;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < perRow; col += 1) {
      const box = boxes[row * perRow + col];
      if (box) {
        box.position.y = currentY;
      }
    }
    currentY += maxHeightByRow[row] + gapY;
  }
  const width = margin * 2 + perRow * boxWidth + Math.max(0, perRow - 1) * gapX;
  const height = Math.max(180, currentY - gapY + margin);
  const relationLines = relationships.map((relationship) =>
    renderSvgRelationship(relationship, positions)
  ).filter(Boolean).join("\n");
  const entityBoxes = boxes.map((box) => renderSvgEntityBox(box, headerHeight, rowHeight)).join("\n");

  return `<svg role="img" aria-label="OceanBase ER diagram" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#136f63"></path>
      </marker>
    </defs>
    ${relationLines}
    ${entityBoxes}
  </svg>`;
}

function defaultMaxColumnsForFormat(format: ErHtmlFormat): number {
  if (format === "html-compact") {
    return 0;
  }
  if (format === "html-detailed" || format === "html-interactive") {
    return 50;
  }
  return 18;
}

function renderSvgEntityBox(
  box: {
    entity: ErEntity;
    visibleColumns: ErColumn[];
    hiddenCount: number;
    position: { x: number; y: number; width: number; height: number };
  },
  headerHeight: number,
  rowHeight: number
): string {
  const { entity, visibleColumns, hiddenCount, position } = box;
  const title = entity.schema ? `${entity.schema}.${entity.table}` : entity.table;
  const rows = visibleColumns.map((column, index) => {
    const y = position.y + headerHeight + 19 + index * rowHeight;
    const flags = [column.primaryKey ? "PK" : "", column.nullable === false ? "NN" : ""].filter(Boolean).join(" ");
    const indexLabel = column.indexed && !column.primaryKey ? " IDX" : "";
    const label = `${column.name}${column.type ? `: ${column.type}` : ""}${flags ? ` [${flags}${indexLabel}]` : indexLabel ? ` [${indexLabel.trim()}]` : ""}`;
    return `<text x="${position.x + 12}" y="${y}" class="column-text">${escapeHtml(label)}</text>`;
  });
  if (hiddenCount > 0) {
    const y = position.y + headerHeight + 19 + visibleColumns.length * rowHeight;
    rows.push(`<text x="${position.x + 12}" y="${y}" class="column-muted">+ ${hiddenCount} more column(s)</text>`);
  }
  return `<g data-entity="${escapeHtml(title.toLowerCase())}">
    <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${position.height}" rx="6" class="entity-box"></rect>
    <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${headerHeight}" rx="6" class="entity-header"></rect>
    <text x="${position.x + 12}" y="${position.y + 22}" class="entity-name">${escapeHtml(title)}</text>
    ${rows.join("\n")}
  </g>`;
}

function renderSvgRelationship(
  relationship: TableRelationship,
  positions: Map<string, { x: number; y: number; width: number; height: number }>
): string {
  const source = positions.get(entityKey(relationship.sourceSchema, relationship.sourceTable));
  const target = positions.get(entityKey(relationship.targetSchema, relationship.targetTable));
  if (!source || !target) {
    return "";
  }
  const sourceX = source.x + source.width / 2;
  const sourceY = source.y + source.height / 2;
  const targetX = target.x + target.width / 2;
  const targetY = target.y + target.height / 2;
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const label = relationship.constraintName ?? relationship.relationType;
  return `<g>
    <path d="M ${targetX} ${targetY} L ${midX} ${midY} L ${sourceX} ${sourceY}" class="rel-line" marker-end="url(#arrow)"></path>
    <text x="${midX + 4}" y="${midY - 4}" class="rel-label">${escapeHtml(label)}</text>
  </g>`;
}

function renderRelationshipTable(relationships: TableRelationship[]): string {
  if (relationships.length === 0) {
    return `<p>No visible relationships matched this ER scope.</p>`;
  }
  const rows = relationships.map((relationship) => {
    const source = tableLabel(relationship.sourceSchema, relationship.sourceTable);
    const target = tableLabel(relationship.targetSchema, relationship.targetTable);
    return `<tr>
      <td>${escapeHtml(source)}.${escapeHtml(relationship.sourceColumns.join(","))}</td>
      <td>${escapeHtml(target)}.${escapeHtml(relationship.targetColumns.join(","))}</td>
      <td>${escapeHtml(relationship.relationType)}</td>
      <td>${relationship.confidence.toFixed(2)}</td>
      <td>${escapeHtml(relationship.evidence.map((item) => item.detail).join(" "))}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead>
      <tr><th>Source</th><th>Target</th><th>Type</th><th>Confidence</th><th>Evidence</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderEntityDetails(entities: ErEntity[]): string {
  if (entities.length === 0) {
    return "";
  }
  return entities.map((entity) => {
    const title = tableLabel(entity.schema, entity.table);
    const rows = entity.columns.map((column) => `<tr>
      <td>${escapeHtml(column.name)}</td>
      <td>${escapeHtml(column.type ?? "")}</td>
      <td>${column.primaryKey ? "yes" : ""}</td>
      <td>${column.nullable === false ? "no" : column.nullable === true ? "yes" : ""}</td>
      <td>${column.indexed ? escapeHtml((column.indexNames ?? []).join(", ")) : ""}</td>
      <td>${escapeHtml(column.comment ?? "")}</td>
    </tr>`).join("");
    return `<h3>${escapeHtml(title)}</h3>
    <table>
      <thead>
        <tr><th>Column</th><th>Type</th><th>PK</th><th>Nullable</th><th>Index</th><th>Comment</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }).join("");
}

function renderInteractiveControls(): string {
  return `<div class="controls">
    <input id="er-search" type="search" placeholder="Search table or column">
    <button type="button" id="er-zoom-in">Zoom in</button>
    <button type="button" id="er-zoom-out">Zoom out</button>
    <button type="button" id="er-reset">Reset</button>
  </div>`;
}

function renderInteractiveScript(): string {
  return `<script>
(() => {
  const wrap = document.querySelector(".svg-wrap");
  const groups = Array.from(document.querySelectorAll("[data-entity]"));
  const search = document.getElementById("er-search");
  let scale = 1;
  function setScale(next) {
    scale = Math.max(0.5, Math.min(2, next));
    wrap.style.transform = "scale(" + scale + ")";
    wrap.style.width = 100 / scale + "%";
  }
  function applySearch() {
    const value = (search.value || "").trim().toLowerCase();
    groups.forEach((group) => {
      const haystack = (group.getAttribute("data-entity") || "") + " " + group.textContent.toLowerCase();
      const matched = !value || haystack.includes(value);
      group.classList.toggle("dimmed", Boolean(value) && !matched);
      group.classList.toggle("match", Boolean(value) && matched);
    });
  }
  document.getElementById("er-zoom-in").addEventListener("click", () => setScale(scale + 0.1));
  document.getElementById("er-zoom-out").addEventListener("click", () => setScale(scale - 0.1));
  document.getElementById("er-reset").addEventListener("click", () => {
    search.value = "";
    setScale(1);
    applySearch();
  });
  search.addEventListener("input", applySearch);
})();
</script>`;
}

function tableLabel(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function plantUmlAlias(schema: string | undefined, table: string): string {
  return `T_${mermaidName(schema ? `${schema}_${table}` : table)}`;
}

function plantUmlText(value: string): string {
  return value.replace(/[{}\r\n]/g, " ").replace(/"/g, "'");
}

function dotId(schema: string | undefined, table: string): string {
  return mermaidName(schema ? `${schema}_${table}` : table);
}

function dotText(value: string): string {
  return value.replace(/["\\{}|<>]/g, "\\$&").replace(/\r?\n/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
