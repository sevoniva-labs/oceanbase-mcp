import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { CompatibilityMode } from "./config.js";
import type { TableRelationship } from "./db.js";
import { buildErGraph, type BuildErGraphOptions, type ErGraph } from "./er-graph.js";

const require = createRequire(import.meta.url);
let cytoscapeBrowserScript: string | undefined;
let cytoscapeDagreBrowserScript: string | undefined;

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
  comment?: string;
  rowEstimate?: {
    value: number;
    exact: false;
    source: string;
  };
  columns: ErColumn[];
}

export interface ErDiagram {
  mode: CompatibilityMode;
  entities: ErEntity[];
  relationships: TableRelationship[];
  graph: ErGraph;
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
  relationships: TableRelationship[],
  graphOptions: BuildErGraphOptions = {}
): ErDiagram {
  return {
    mode,
    entities,
    relationships,
    graph: buildErGraph(mode, entities, relationships, graphOptions),
    mermaid: renderMermaidEr(entities, relationships)
  };
}

export function renderErHtml(diagram: ErDiagram, options: ErHtmlOptions = {}): string {
  const title = options.title ?? "OceanBase ER Diagram";
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const format = options.format ?? "html-static";
  if (format === "html-interactive") {
    return renderInteractiveErMapHtml(diagram, { ...options, title, generatedAt, format });
  }
  const maxColumns = Math.max(
    0,
    Math.min(options.maxColumnsPerEntity ?? defaultMaxColumnsForFormat(format, diagram.entities.length), 50)
  );
  const layout = describeErLayout(diagram.entities.length, maxColumns);
  const svg = renderSvgEr(diagram.entities, diagram.relationships, maxColumns);
  const interactive = false;
  const metadataJson = JSON.stringify({
    mode: diagram.mode,
    entities: diagram.entities,
    relationships: diagram.relationships
  }, null, format === "html-compact" ? 0 : 2);
  const dataJson = JSON.stringify({
    entities: diagram.entities,
    relationships: diagram.relationships
  });
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
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-soft: #f8fafb;
      --text: #18202a;
      --muted: #617080;
      --subtle: #8792a0;
      --line: #d8dee6;
      --line-strong: #b9c4d0;
      --accent: #0f766e;
      --accent-strong: #0b5f59;
      --accent-soft: #e3f4f1;
      --info: #1f5f99;
      --info-soft: #eaf3fb;
      --warn: #8a5a00;
      --warn-soft: #fff6db;
      --danger: #a23b3b;
      --shadow: 0 8px 28px rgba(24, 32, 42, 0.08);
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .app-shell { min-height: 100vh; display: flex; flex-direction: column; }
    header {
      padding: 18px 24px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    h1 { margin: 0 0 10px; font-size: 20px; font-weight: 700; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 15px; font-weight: 700; letter-spacing: 0; }
    h3 { margin: 0 0 8px; font-size: 14px; font-weight: 700; letter-spacing: 0; }
    .meta { color: var(--muted); display: flex; flex-wrap: wrap; gap: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .workspace {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(480px, 1fr) minmax(260px, 340px);
      gap: 16px;
      padding: 16px;
      min-height: 0;
      flex: 1;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .sidebar, .inspector { overflow: hidden; display: flex; flex-direction: column; min-height: 560px; }
    .panel-head {
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .panel-body { padding: 12px 14px; overflow: auto; }
    .diagram-panel { min-width: 0; display: flex; flex-direction: column; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .toolbar .spacer { flex: 1; }
    .toolbar .group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    input[type="search"] {
      width: 100%;
      min-height: 34px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
      outline: none;
    }
    input[type="search"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    button {
      min-height: 32px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      white-space: nowrap;
    }
    button:hover { border-color: var(--line-strong); background: var(--panel-soft); }
    button:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 1px; }
    .table-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 6px;
    }
    .table-item {
      width: 100%;
      display: block;
      text-align: left;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 8px 9px;
      background: transparent;
      cursor: pointer;
    }
    .table-item:hover, .table-item.active {
      border-color: var(--line-strong);
      background: var(--panel-soft);
    }
    .table-item.active { box-shadow: inset 3px 0 0 var(--accent); }
    .table-name { display: block; font-weight: 700; overflow-wrap: anywhere; }
    .table-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; color: var(--subtle); font-size: 12px; }
    .filter-meta { margin-top: 8px; color: var(--muted); font-size: 12px; }
    .canvas {
      min-height: 560px;
      overflow: auto;
      background:
        linear-gradient(var(--line) 1px, transparent 1px),
        linear-gradient(90deg, var(--line) 1px, transparent 1px),
        #fbfcfd;
      background-size: 28px 28px;
      cursor: grab;
      flex: 1;
    }
    .canvas.dragging { cursor: grabbing; }
    .svg-wrap {
      display: inline-block;
      min-width: 100%;
      min-height: 100%;
      padding: 22px;
      transform-origin: 0 0;
    }
    .warnings {
      border: 1px solid #f0cf84;
      background: var(--warn-soft);
      color: var(--warn);
      border-radius: 8px;
      padding: 12px 14px;
      margin: 16px 16px 0;
      max-height: 168px;
      overflow: auto;
    }
    .warnings-title {
      margin-bottom: 6px;
      font-weight: 700;
    }
    .warning-list {
      display: grid;
      gap: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      font-size: 13px;
    }
    th, td { padding: 8px 9px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef2f5; font-weight: 700; color: #344153; }
    tr:last-child td { border-bottom: 0; }
    tbody tr[data-source] { cursor: pointer; }
    tbody tr[data-source]:hover { background: var(--panel-soft); }
    .rel-section { padding: 0 16px 18px; }
    details {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    summary { cursor: pointer; font-weight: 700; }
    pre {
      overflow: auto;
      white-space: pre;
      background: #111827;
      color: #e5e7eb;
      border-radius: 6px;
      padding: 12px;
      font: 12px/1.5 var(--mono);
    }
    .entity-box { fill: #ffffff; stroke: #9aa9b8; stroke-width: 1; filter: drop-shadow(0 3px 8px rgba(24,32,42,0.10)); }
    .entity-header { fill: #eef7f5; stroke: #9aa9b8; stroke-width: 1; }
    .entity-name { fill: var(--text); font-weight: 700; font-size: 13px; }
    .entity-count { fill: var(--muted); font-size: 11px; }
    .column-text { fill: #2b3645; font-size: 12px; }
    .column-muted { fill: var(--muted); font-size: 11px; }
    .column-key { fill: var(--accent-strong); font-weight: 700; font-size: 11px; }
    .rel-line { stroke: #607d8b; stroke-width: 1.6; fill: none; opacity: 0.6; }
    .rel-hit { stroke: transparent; stroke-width: 12; fill: none; pointer-events: stroke; }
    .rel-group.active .rel-line, .rel-group.connected .rel-line { stroke: var(--accent); stroke-width: 2.4; opacity: 1; }
    .rel-group.dimmed .rel-line { opacity: 0.08; }
    .entity-node { cursor: pointer; }
    .entity-node.dimmed { opacity: 0.18; }
    .entity-node.connected .entity-box { stroke: var(--accent); stroke-width: 1.8; }
    .entity-node.active .entity-box { stroke: var(--accent-strong); stroke-width: 2.4; }
    .entity-node.match .entity-box { stroke: var(--info); stroke-width: 2; }
    .empty-state { color: var(--muted); padding: 10px 0; }
    .detail-title { font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
    .detail-meta { color: var(--muted); margin: 4px 0 12px; }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    .overview-stat { border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel-soft); }
    .overview-value { display: block; font-weight: 700; font-size: 17px; }
    .overview-label { display: block; color: var(--muted); font-size: 12px; }
    .field-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .field-item { border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel-soft); }
    .field-name { font-weight: 700; overflow-wrap: anywhere; }
    .field-type { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    .badge { display: inline-flex; margin: 4px 4px 0 0; padding: 2px 5px; border-radius: 4px; background: var(--info-soft); color: var(--info); font-size: 11px; }
    .badge.key { background: var(--accent-soft); color: var(--accent-strong); }
    .badge.warn { background: var(--warn-soft); color: var(--warn); }
    .source-block { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .docs-section { padding: 0 16px 24px; }
    @media (max-width: 1120px) {
      .workspace { grid-template-columns: 240px minmax(420px, 1fr); }
      .inspector { grid-column: 1 / -1; min-height: 0; }
    }
    @media (max-width: 760px) {
      header { position: static; padding: 14px; }
      .workspace { display: block; padding: 12px; }
      .panel { margin-bottom: 12px; }
      .sidebar, .inspector { min-height: 0; max-height: 420px; }
      .canvas { min-height: 420px; }
      .toolbar .spacer { display: none; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <span class="pill">Mode: ${escapeHtml(diagram.mode)}</span>
        <span class="pill">Format: ${escapeHtml(format)}</span>
        <span class="pill">Tables: ${diagram.entities.length}</span>
        <span class="pill">Relationships: ${diagram.relationships.length}</span>
        <span class="pill">Generated: ${escapeHtml(generatedAt)}</span>
      </div>
    </header>
    ${warnings.length > 0 ? `<section class="warnings" aria-label="Warnings"><div class="warnings-title">Warnings (${warnings.length})</div><div class="warning-list">${warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join("")}</div></section>` : ""}
    <div class="workspace">
      <aside class="panel sidebar">
        <div class="panel-head">
          <h2>Tables</h2>
          ${interactive ? `<input id="er-search" type="search" placeholder="Search table or column" autocomplete="off">` : ""}
          ${interactive ? `<div class="filter-meta"><span id="er-filter-count">${diagram.entities.length}</span> / ${diagram.entities.length} tables</div>` : ""}
        </div>
        <div class="panel-body">
          ${renderTableList(diagram.entities)}
        </div>
      </aside>
      <main class="panel diagram-panel">
        <div class="toolbar">
          <span class="group">${interactive ? renderInteractiveControls() : `<span class="pill">Static diagram</span>`}</span>
          <span class="spacer"></span>
          <span class="pill">${layout}</span>
          <span class="pill">${maxColumns === 0 ? "Compact fields" : `Showing up to ${maxColumns} fields per table`}</span>
        </div>
        <section class="canvas" id="er-canvas">
          <div class="svg-wrap">${svg}</div>
        </section>
      </main>
      <aside class="panel inspector">
        <div class="panel-head">
          <h2>Table Detail</h2>
        </div>
        <div class="panel-body" id="er-inspector">
          ${renderInspectorDefault(diagram.entities, diagram.relationships)}
        </div>
      </aside>
    </div>
    <section class="rel-section">
      <div class="panel">
        <div class="panel-head"><h2>Relationships</h2></div>
        <div class="panel-body">${renderRelationshipTable(diagram.relationships)}</div>
      </div>
    </section>
    ${format === "html-compact" ? "" : `<section class="docs-section">
      <details>
        <summary>Mermaid Source</summary>
        <pre>${escapeHtml(diagram.mermaid)}</pre>
      </details>
      <details>
        <summary>JSON Metadata</summary>
        <pre>${escapeHtml(metadataJson)}</pre>
      </details>
    </section>`}
  </div>
  ${interactive ? `<script type="application/json" id="er-data">${escapeScriptJson(dataJson)}</script>${renderInteractiveScript()}` : ""}
</body>
</html>`;
}

function renderInteractiveErMapHtml(
  diagram: ErDiagram,
  options: ErHtmlOptions & { title: string; generatedAt: string; format: ErHtmlFormat }
): string {
  const graphJson = JSON.stringify(diagram.graph);
  const diagnostics = diagram.graph.diagnostics;
  const notes = options.warnings ?? [];
  const status = diagram.graph.status;
  const schemas = uniqueStrings(diagram.graph.nodes.map((node) => node.schema).filter((value): value is string => Boolean(value)));
  const domains = uniqueStrings(diagram.graph.nodes.map((node) => node.domain).filter(Boolean));
  const overviewHtml = renderGraphOverview(diagram.graph);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fa;
      --panel: #ffffff;
      --panel-soft: #f8fafc;
      --text: #17202b;
      --muted: #5b6878;
      --subtle: #8290a0;
      --line: #d9e0e8;
      --line-strong: #b7c3cf;
      --accent: #0f766e;
      --accent-soft: #dff4f1;
      --info: #1f5f99;
      --info-soft: #e8f2fb;
      --warn: #8a5a00;
      --warn-soft: #fff5d6;
      --danger: #9f3131;
      --danger-soft: #fdecec;
      --shadow: 0 8px 24px rgba(23, 32, 43, 0.08);
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .app-shell { min-height: 100vh; display: flex; flex-direction: column; }
    header {
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 20;
    }
    h1 { margin: 0 0 10px; font-size: 20px; font-weight: 700; letter-spacing: 0; }
    h2 { margin: 0 0 10px; font-size: 15px; font-weight: 700; letter-spacing: 0; }
    h3 { margin: 14px 0 8px; font-size: 14px; font-weight: 700; letter-spacing: 0; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .status-ok { background: #edf8f3; border-color: #b9e2cf; color: #11613a; }
    .status-partial { background: var(--warn-soft); border-color: #f0cf84; color: var(--warn); }
    .status-needs-scope, .status-failed { background: var(--danger-soft); border-color: #efb4b4; color: var(--danger); }
    .workspace {
      display: grid;
      grid-template-columns: minmax(260px, 320px) minmax(520px, 1fr) minmax(300px, 380px);
      gap: 14px;
      padding: 14px;
      flex: 0 0 auto;
      min-height: 560px;
      height: calc(100vh - 96px);
      overflow: hidden;
    }
    .panel {
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .panel-head { padding: 13px 14px 10px; border-bottom: 1px solid var(--line); background: var(--panel); }
    .panel-body { padding: 12px 14px; overflow: auto; min-height: 0; }
    .sidebar, .inspector { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .sidebar .panel-body, .inspector .panel-body { flex: 1; min-height: 0; }
    .diagram-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .toolbar .spacer { flex: 1; }
    button, select, input[type="search"] {
      min-height: 32px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      font: inherit;
    }
    button { padding: 6px 10px; cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--panel-soft); border-color: var(--line-strong); }
    select { width: 100%; padding: 6px 8px; }
    input[type="search"] { width: 100%; padding: 7px 10px; outline: none; }
    input[type="search"]:focus, select:focus, button:focus-visible {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
      outline: none;
    }
    .filter-grid { display: grid; gap: 10px; }
    .filter-label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    .check-row { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
    .table-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
    .table-item {
      width: 100%;
      display: block;
      text-align: left;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 8px 9px;
      background: transparent;
      cursor: pointer;
    }
    .table-item:hover, .table-item.active { border-color: var(--line-strong); background: var(--panel-soft); }
    .table-name { display: block; font-weight: 700; overflow-wrap: anywhere; }
    .table-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; color: var(--subtle); font-size: 12px; }
    .filter-meta { margin-top: 8px; color: var(--muted); font-size: 12px; }
    #er-map { position: relative; flex: 1; min-height: 0; background: #fbfcfd; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
    .legend-item { display: inline-flex; align-items: center; gap: 5px; }
    .legend-line { width: 18px; height: 0; border-top: 2px solid #58768a; }
    .legend-line.dashed { border-top-style: dashed; }
    .detail-title { font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
    .detail-meta { margin-top: 4px; color: var(--muted); }
    .overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
    .overview-stat { border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel-soft); }
    .overview-value { display: block; font-weight: 700; font-size: 17px; }
    .overview-label { display: block; color: var(--muted); font-size: 12px; }
    .field-list { display: grid; gap: 8px; list-style: none; padding: 0; margin: 0; }
    .field-item { border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel-soft); }
    .relationship-item {
      width: 100%;
      display: block;
      text-align: left;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px;
      background: var(--panel-soft);
      white-space: normal;
    }
    .relationship-item:hover { border-color: var(--line-strong); background: #fff; }
    .field-name { font-weight: 700; overflow-wrap: anywhere; }
    .field-type { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    .badge { display: inline-flex; margin: 4px 4px 0 0; padding: 2px 5px; border-radius: 4px; background: var(--info-soft); color: var(--info); font-size: 11px; }
    .badge.key { background: var(--accent-soft); color: var(--accent); }
    .empty-state { color: var(--muted); padding: 10px 0; }
    .diagnostics {
      margin: 0 14px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    .diagnostics summary { cursor: pointer; padding: 10px 12px; font-weight: 700; }
    .diagnostics-body { border-top: 1px solid var(--line); padding: 10px 12px; color: var(--muted); }
    .diagnostics-body ul { margin: 0; padding-left: 18px; }
    @media (max-width: 1120px) {
      .workspace { grid-template-columns: 280px minmax(420px, 1fr); height: auto; min-height: 0; overflow: visible; }
      .diagram-panel { min-height: 560px; }
      .sidebar, .inspector { max-height: 520px; }
      .inspector { grid-column: 1 / -1; min-height: 0; }
    }
    @media (max-width: 760px) {
      header { position: static; padding: 14px; }
      .workspace { display: block; padding: 12px; }
      .panel { margin-bottom: 12px; }
      .sidebar, .inspector, .diagram-panel { min-height: 0; }
      #er-map { min-height: 480px; }
      .toolbar .spacer { display: none; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <header>
      <h1>${escapeHtml(options.title)}</h1>
      <div class="meta">
        <span class="pill status-${status.toLowerCase().replace(/\s+/g, "-")}">Status: ${escapeHtml(status)}</span>
        <span class="pill">Mode: ${escapeHtml(diagram.mode)}</span>
        <span class="pill">Format: ${escapeHtml(options.format)}</span>
        <span class="pill">Tables: ${diagram.graph.summary.tableCount}</span>
        <span class="pill">Visible relationships: <span id="er-visible-relationships">${diagram.graph.summary.visibleRelationships}</span></span>
        <span class="pill">Generated: ${escapeHtml(options.generatedAt)}</span>
      </div>
    </header>
    <div class="workspace">
      <aside class="panel sidebar">
        <div class="panel-head">
          <h2>Tables</h2>
          <div class="filter-grid">
            <input id="er-search" type="search" placeholder="Search table, column, or comment" autocomplete="off">
            <label class="filter-label">Schema
              <select id="er-schema-filter">
                <option value="">All schemas</option>
                ${schemas.map((schema) => `<option value="${escapeHtml(schema)}">${escapeHtml(schema)}</option>`).join("")}
              </select>
            </label>
            <label class="filter-label">Domain
              <select id="er-domain-filter">
                <option value="">All domains</option>
                ${domains.map((domain) => `<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`).join("")}
              </select>
            </label>
            <label class="check-row"><input type="checkbox" data-relation-filter="confirmed" checked> Confirmed</label>
            <label class="check-row"><input type="checkbox" data-relation-filter="probable" checked> Probable</label>
            <label class="check-row"><input type="checkbox" data-relation-filter="possible"> Possible</label>
          </div>
          <div class="filter-meta"><span id="er-filter-count">${diagram.graph.nodes.length}</span> / ${diagram.graph.nodes.length} tables</div>
        </div>
        <div class="panel-body">
          <ul class="table-list" id="er-table-list"></ul>
        </div>
      </aside>
      <main class="panel diagram-panel">
        <div class="toolbar">
          <button type="button" id="er-fit">Fit</button>
          <button type="button" id="er-reset">Reset</button>
          <button type="button" id="er-neighborhood">Neighborhood</button>
          <span class="spacer"></span>
          <div class="legend">
            <span class="legend-item"><span class="legend-line"></span> confirmed</span>
            <span class="legend-item"><span class="legend-line dashed"></span> inferred</span>
          </div>
        </div>
        <section id="er-map" aria-label="OceanBase ER graph"></section>
      </main>
      <aside class="panel inspector">
        <div class="panel-head"><h2>Detail</h2></div>
        <div class="panel-body" id="er-inspector">${overviewHtml}</div>
      </aside>
    </div>
    ${renderDiagnosticsDetails(diagnostics, notes)}
  </div>
  <script>${loadCytoscapeBrowserScript()}</script>
  <script>${loadCytoscapeDagreBrowserScript()}</script>
  <script type="application/json" id="er-graph-data">${escapeScriptJson(graphJson)}</script>
  ${renderErMapScript(overviewHtml)}
</body>
</html>`;
}

function renderGraphOverview(graph: ErGraph): string {
  return `<div class="detail-title">Schema Overview</div>
    <div class="detail-meta">Select a table or relationship to inspect metadata and evidence.</div>
    <div class="overview-grid">
      <div class="overview-stat"><span class="overview-value">${graph.summary.tableCount}</span><span class="overview-label">tables</span></div>
      <div class="overview-stat"><span class="overview-value">${graph.summary.visibleRelationships}</span><span class="overview-label">visible relationships</span></div>
      <div class="overview-stat"><span class="overview-value">${graph.summary.confirmedRelationships}</span><span class="overview-label">confirmed</span></div>
      <div class="overview-stat"><span class="overview-value">${graph.summary.probableRelationships}</span><span class="overview-label">probable</span></div>
    </div>`;
}

function renderDiagnosticsDetails(diagnostics: ErGraph["diagnostics"], notes: string[] = []): string {
  if (diagnostics.length === 0 && notes.length === 0) {
    return "";
  }
  const diagnosticItems = diagnostics.map((diagnostic) => `<li>${escapeHtml(diagnostic.message)}${diagnostic.action ? ` ${escapeHtml(diagnostic.action)}` : ""}</li>`).join("");
  const noteItems = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<details class="diagnostics">
    <summary>Diagnostics (${diagnostics.length + notes.length})</summary>
    <div class="diagnostics-body">
      ${diagnosticItems ? `<h3>Findings</h3><ul>${diagnosticItems}</ul>` : ""}
      ${noteItems ? `<h3>Notes</h3><ul>${noteItems}</ul>` : ""}
    </div>
  </details>`;
}

function loadCytoscapeBrowserScript(): string {
  cytoscapeBrowserScript ??= readFileSync(require.resolve("cytoscape/dist/cytoscape.min.js"), "utf8");
  return cytoscapeBrowserScript;
}

function loadCytoscapeDagreBrowserScript(): string {
  cytoscapeDagreBrowserScript ??= readFileSync(
    require.resolve("cytoscape-dagre").replace(/cytoscape-dagre\.js$/, "cytoscape-dagre.min.js"),
    "utf8"
  );
  return cytoscapeDagreBrowserScript;
}

function renderErMapScript(overviewHtml: string): string {
  return `<script>
(() => {
  const graph = JSON.parse(document.getElementById("er-graph-data").textContent || "{}");
  const overviewHtml = ${JSON.stringify(overviewHtml)};
  const map = document.getElementById("er-map");
  const inspector = document.getElementById("er-inspector");
  const tableList = document.getElementById("er-table-list");
  const search = document.getElementById("er-search");
  const schemaFilter = document.getElementById("er-schema-filter");
  const domainFilter = document.getElementById("er-domain-filter");
  const filterCount = document.getElementById("er-filter-count");
  const visibleRelationshipCount = document.getElementById("er-visible-relationships");
  const relationFilters = Array.from(document.querySelectorAll("[data-relation-filter]"));
  const nodesById = new Map((graph.nodes || []).map((node) => [node.id, node]));
  const edgesById = new Map((graph.edges || []).map((edge) => [edge.id, edge]));
  let focusedNodeId = "";

  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function activeRelationClasses() {
    return new Set(relationFilters.filter((item) => item.checked).map((item) => item.getAttribute("data-relation-filter")));
  }
  function nodeMatches(node) {
    const term = (search.value || "").trim().toLowerCase();
    const schema = schemaFilter.value;
    const domain = domainFilter.value;
    return (!term || (node.searchText || "").includes(term))
      && (!schema || node.schema === schema)
      && (!domain || node.domain === domain);
  }
  function edgeMatches(edge, visibleNodeIds) {
    return activeRelationClasses().has(edge.relationClass)
      && visibleNodeIds.has(edge.source)
      && visibleNodeIds.has(edge.target);
  }
  function visibleGraphElements() {
    const visibleNodes = (graph.nodes || []).filter(nodeMatches);
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = (graph.edges || []).filter((edge) => edgeMatches(edge, visibleNodeIds));
    return {
      nodes: visibleNodes.map((node) => ({
        group: "nodes",
        data: {
          id: node.id,
          label: node.qualifiedName,
          domain: node.domain,
          schema: node.schema || "",
          columnCount: (node.columns || []).length,
          primaryKeyCount: (node.primaryKeys || []).length
        }
      })),
      edges: visibleEdges.map((edge) => ({
        group: "edges",
        data: {
          id: edge.id,
          source: edge.target,
          target: edge.source,
          label: edge.label,
          relationClass: edge.relationClass,
          relationType: edge.relationType,
          confidence: edge.confidence
        }
      }))
    };
  }
  function renderTableList() {
    const visibleNodes = (graph.nodes || []).filter(nodeMatches);
    filterCount.textContent = String(visibleNodes.length);
    if (visibleNodes.length === 0) {
      tableList.innerHTML = '<li class="empty-state">No tables match the current filters.</li>';
      return;
    }
    tableList.innerHTML = visibleNodes.map((node) => '<li><button type="button" class="table-item" data-table="' + escape(node.id) + '"><span class="table-name">' + escape(node.qualifiedName) + '</span><span class="table-meta"><span>' + (node.columns || []).length + ' columns</span><span>' + escape(node.domain) + '</span></span></button></li>').join("");
    tableList.querySelectorAll("[data-table]").forEach((button) => {
      button.addEventListener("click", () => focusNode(button.getAttribute("data-table") || ""));
    });
  }
  function renderGraph() {
    const elements = visibleGraphElements();
    cy.elements().remove();
    cy.add([...elements.nodes, ...elements.edges]);
    map.dataset.visibleTables = String(elements.nodes.length);
    map.dataset.visibleRelationships = String(elements.edges.length);
    visibleRelationshipCount.textContent = String(elements.edges.length);
    const readableGraph = elements.nodes.length > 12;
    cy.layout({
      name: "dagre",
      rankDir: "LR",
      nodeSep: 70,
      rankSep: 120,
      edgeSep: 24,
      fit: !readableGraph,
      padding: 40
    }).run();
    if (readableGraph) {
      const firstNode = cy.nodes()[0];
      if (firstNode) {
        cy.zoom(elements.nodes.length > 80 ? 0.65 : 0.9);
        cy.center(firstNode);
      }
    }
    renderTableList();
    const visibleNodeIds = new Set(elements.nodes.map((element) => element.data.id));
    if (focusedNodeId && !visibleNodeIds.has(focusedNodeId)) {
      focusedNodeId = "";
      inspector.innerHTML = overviewHtml;
    }
  }
  function renderNodeDetail(node) {
    const direct = (graph.edges || []).filter((edge) => edge.source === node.id || edge.target === node.id);
    const fields = (node.columns || []).map((column) => {
      const badges = [
        column.primaryKey ? '<span class="badge key">PK</span>' : '',
        column.nullable === false ? '<span class="badge">NOT NULL</span>' : '',
        column.indexed ? '<span class="badge">IDX</span>' : ''
      ].join("");
      return '<li class="field-item"><div class="field-name">' + escape(column.name) + '</div><div class="field-type">' + escape(column.type || "") + '</div>' + badges + (column.comment ? '<div class="field-type">' + escape(column.comment) + '</div>' : '') + '</li>';
    }).join("");
    const rels = direct.length
      ? '<h3>Relationships</h3><div class="field-list">' + direct.map((edge) => {
          const other = edge.source === node.id ? nodesById.get(edge.target) : nodesById.get(edge.source);
          return '<button type="button" class="relationship-item" data-edge-detail="' + escape(edge.id) + '"><div class="field-name">' + escape(other ? other.qualifiedName : "") + '</div><div class="field-type">' + escape(edge.relationClass + " / " + edge.relationType + " / confidence " + edge.confidence) + '</div></button>';
        }).join("") + '</div>'
      : '<p class="empty-state">No direct relationship is visible for this table.</p>';
    inspector.innerHTML = '<div class="detail-title">' + escape(node.qualifiedName) + '</div><div class="detail-meta">' + escape(node.domain) + ' / ' + (node.columns || []).length + ' column(s)</div><h3>Columns</h3><ul class="field-list">' + fields + '</ul>' + rels;
    inspector.querySelectorAll("[data-edge-detail]").forEach((button) => {
      button.addEventListener("click", () => renderEdgeDetail(edgesById.get(button.getAttribute("data-edge-detail") || "")));
    });
  }
  function renderEdgeDetail(edge) {
    if (!edge) {
      inspector.innerHTML = overviewHtml;
      return;
    }
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    const evidence = (edge.evidence || []).map((item) => '<li class="field-item"><div class="field-name">' + escape(item.type) + '</div><div class="field-type">' + escape(item.detail) + '</div></li>').join("");
    inspector.innerHTML = '<div class="detail-title">' + escape(edge.label) + '</div><div class="detail-meta">' + escape(edge.relationClass + " / " + edge.relationType + " / confidence " + edge.confidence) + '</div><h3>Mapping</h3><ul class="field-list"><li class="field-item"><div class="field-name">' + escape(source ? source.qualifiedName : edge.sourceTable) + '.' + escape((edge.sourceColumns || []).join(",")) + '</div><div class="field-type">source</div></li><li class="field-item"><div class="field-name">' + escape(target ? target.qualifiedName : edge.targetTable) + '.' + escape((edge.targetColumns || []).join(",")) + '</div><div class="field-type">target</div></li></ul><h3>Evidence</h3>' + (evidence ? '<ul class="field-list">' + evidence + '</ul>' : '<p class="empty-state">No detailed evidence is available for this relationship.</p>');
  }
  function focusNode(id) {
    focusedNodeId = id;
    map.dataset.selectedTable = id;
    const node = nodesById.get(id);
    cy.elements().removeClass("faded selected neighbor");
    document.querySelectorAll(".table-item").forEach((item) => item.classList.toggle("active", item.getAttribute("data-table") === id));
    if (!node) {
      inspector.innerHTML = overviewHtml;
      return;
    }
    const cyNode = cy.getElementById(id);
    const neighborhood = cyNode.closedNeighborhood();
    cy.elements().not(neighborhood).addClass("faded");
    neighborhood.nodes().not(cyNode).addClass("neighbor");
    cyNode.addClass("selected");
    cy.fit(neighborhood, 40);
    renderNodeDetail(node);
  }
  const cy = cytoscape({
    container: map,
    wheelSensitivity: 0.2,
    elements: [],
    style: [
      { selector: "node", style: {
        "shape": "round-rectangle",
        "width": 190,
        "height": 54,
        "background-color": "#ffffff",
        "border-width": 1,
        "border-color": "#9aa9b8",
        "label": "data(label)",
        "font-size": 11,
        "font-weight": 600,
        "text-wrap": "wrap",
        "text-max-width": 168,
        "text-valign": "center",
        "text-halign": "center",
        "color": "#17202b"
      }},
      { selector: "edge", style: {
        "width": 1.8,
        "line-color": "#58768a",
        "target-arrow-color": "#58768a",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "opacity": 0.78
      }},
      { selector: 'edge[relationClass = "probable"]', style: { "line-style": "dashed", "line-color": "#0f766e", "target-arrow-color": "#0f766e" }},
      { selector: 'edge[relationClass = "possible"]', style: { "line-style": "dotted", "line-color": "#8a5a00", "target-arrow-color": "#8a5a00", "opacity": 0.55 }},
      { selector: ".selected", style: { "border-width": 3, "border-color": "#0f766e", "background-color": "#e3f4f1" }},
      { selector: ".neighbor", style: { "border-width": 2, "border-color": "#1f5f99" }},
      { selector: ".faded", style: { "opacity": 0.12 }}
    ]
  });
  cy.on("tap", "node", (event) => focusNode(event.target.id()));
  cy.on("tap", "edge", (event) => {
    cy.elements().removeClass("faded selected neighbor");
    event.target.addClass("selected");
    renderEdgeDetail(edgesById.get(event.target.id()));
  });
  cy.on("tap", (event) => {
    if (event.target === cy) {
      focusedNodeId = "";
      map.dataset.selectedTable = "";
      cy.elements().removeClass("faded selected neighbor");
      inspector.innerHTML = overviewHtml;
      renderTableList();
    }
  });
  search.addEventListener("input", renderGraph);
  schemaFilter.addEventListener("change", renderGraph);
  domainFilter.addEventListener("change", renderGraph);
  relationFilters.forEach((item) => item.addEventListener("change", renderGraph));
  document.getElementById("er-fit").addEventListener("click", () => cy.fit(undefined, 40));
  document.getElementById("er-reset").addEventListener("click", () => {
    search.value = "";
    schemaFilter.value = "";
    domainFilter.value = "";
    relationFilters.forEach((item) => {
      item.checked = item.getAttribute("data-relation-filter") !== "possible";
    });
    focusedNodeId = "";
    map.dataset.selectedTable = "";
    renderGraph();
    inspector.innerHTML = overviewHtml;
  });
  document.getElementById("er-neighborhood").addEventListener("click", () => {
    if (focusedNodeId) {
      focusNode(focusedNodeId);
    }
  });
  renderGraph();
})();
</script>`;
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

  const gridColumns = erGridColumns(entities.length);
  const boxWidth = entities.length > 120 ? 258 : entities.length > 40 ? 276 : 300;
  const headerHeight = 44;
  const rowHeight = entities.length > 120 ? 20 : 22;
  const gapX = entities.length > 120 ? 56 : entities.length > 40 ? 74 : 112;
  const gapY = entities.length > 120 ? 30 : 42;
  const margin = 30;
  const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
  const boxes = entities.map((entity, index) => {
    const visibleColumns = selectVisibleColumns(entity, maxColumns);
    const hiddenCount = Math.max(0, entity.columns.length - visibleColumns.length);
    const height = headerHeight + rowHeight * (visibleColumns.length + (hiddenCount > 0 || maxColumns === 0 ? 1 : 0)) + 12;
    const x = margin + (index % gridColumns) * (boxWidth + gapX);
    const y = margin + Math.floor(index / gridColumns) * (height + gapY);
    const position = { x, y, width: boxWidth, height };
    positions.set(entityKey(entity.schema, entity.table), position);
    return { entity, visibleColumns, hiddenCount, position };
  });
  const rows = Math.ceil(entities.length / gridColumns);
  const maxHeightByRow = new Array(rows).fill(0);
  boxes.forEach((box, index) => {
    const row = Math.floor(index / gridColumns);
    maxHeightByRow[row] = Math.max(maxHeightByRow[row], box.position.height);
  });
  let currentY = margin;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < gridColumns; col += 1) {
      const box = boxes[row * gridColumns + col];
      if (box) {
        box.position.y = currentY;
      }
    }
    currentY += maxHeightByRow[row] + gapY;
  }
  const width = margin * 2 + gridColumns * boxWidth + Math.max(0, gridColumns - 1) * gapX;
  const height = Math.max(180, currentY - gapY + margin);
  const relationLines = relationships.map((relationship, index) =>
    renderSvgRelationship(relationship, positions, index)
  ).filter(Boolean).join("\n");
  const entityBoxes = boxes.map((box) => renderSvgEntityBox(box, headerHeight, rowHeight)).join("\n");

  return `<svg role="img" aria-label="OceanBase ER diagram" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-layout-columns="${gridColumns}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#136f63"></path>
      </marker>
    </defs>
    ${relationLines}
    ${entityBoxes}
  </svg>`;
}

function defaultMaxColumnsForFormat(format: ErHtmlFormat, tableCount: number): number {
  if (format === "html-compact") {
    return 0;
  }
  if (format === "html-detailed") {
    if (tableCount > 120) {
      return 12;
    }
    if (tableCount > 40) {
      return 20;
    }
    return 50;
  }
  if (format === "html-interactive") {
    if (tableCount > 120) {
      return 6;
    }
    if (tableCount > 40) {
      return 10;
    }
    return 50;
  }
  if (tableCount > 120) {
    return 6;
  }
  if (tableCount > 40) {
    return 10;
  }
  return 18;
}

function erGridColumns(tableCount: number): number {
  if (tableCount <= 1) {
    return 1;
  }
  if (tableCount <= 6) {
    return 2;
  }
  if (tableCount <= 18) {
    return 3;
  }
  if (tableCount <= 45) {
    return 4;
  }
  if (tableCount <= 100) {
    return 5;
  }
  if (tableCount <= 180) {
    return 6;
  }
  return 8;
}

function describeErLayout(tableCount: number, maxColumns: number): string {
  const columns = erGridColumns(tableCount);
  if (tableCount <= 1) {
    return "Single table layout";
  }
  return `${columns}-column overview layout${maxColumns <= 12 && tableCount > 40 ? " / key fields first" : ""}`;
}

function selectVisibleColumns(entity: ErEntity, maxColumns: number): ErColumn[] {
  if (maxColumns <= 0) {
    return [];
  }
  if (entity.columns.length <= maxColumns) {
    return entity.columns;
  }
  const selected = new Set<ErColumn>();
  for (const column of entity.columns) {
    if ((column.primaryKey || column.indexed) && selected.size < maxColumns) {
      selected.add(column);
    }
  }
  for (const column of entity.columns) {
    if (selected.size >= maxColumns) {
      break;
    }
    selected.add(column);
  }
  return entity.columns.filter((column) => selected.has(column));
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
  const key = entityKey(entity.schema, entity.table);
  const rows = visibleColumns.map((column, index) => {
    const y = position.y + headerHeight + 19 + index * rowHeight;
    const badges = [column.primaryKey ? "PK" : "", column.nullable === false ? "NN" : "", column.indexed && !column.primaryKey ? "IDX" : ""].filter(Boolean).join(" ");
    const label = truncateText(`${column.name}${column.type ? `: ${column.type}` : ""}`, Math.max(24, Math.floor((position.width - 92) / 7)));
    return `<text x="${position.x + 12}" y="${y}" class="${column.primaryKey ? "column-key" : "column-text"}">${escapeHtml(label)}</text>${badges ? `<text x="${position.x + position.width - 12}" y="${y}" text-anchor="end" class="column-muted">${escapeHtml(badges)}</text>` : ""}`;
  });
  if (hiddenCount > 0 || visibleColumns.length === 0) {
    const y = position.y + headerHeight + 19 + visibleColumns.length * rowHeight;
    const label = visibleColumns.length === 0 ? `${entity.columns.length} column(s)` : `+ ${hiddenCount} more column(s)`;
    rows.push(`<text x="${position.x + 12}" y="${y}" class="column-muted">${escapeHtml(label)}</text>`);
  }
  const pkCount = entity.columns.filter((column) => column.primaryKey).length;
  const indexedCount = entity.columns.filter((column) => column.indexed).length;
  const countLabel = `${entity.columns.length} col${pkCount ? ` / ${pkCount} pk` : ""}${indexedCount ? ` / ${indexedCount} idx` : ""}`;
  return `<g class="entity-node" data-node="${escapeHtml(key)}" data-label="${escapeHtml(title.toLowerCase())}" data-x="${position.x}" data-y="${position.y}" data-width="${position.width}" data-height="${position.height}">
    <title>${escapeHtml(title)}</title>
    <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${position.height}" rx="6" class="entity-box"></rect>
    <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${headerHeight}" rx="6" class="entity-header"></rect>
    <text x="${position.x + 12}" y="${position.y + 18}" class="entity-name">${escapeHtml(truncateText(title, Math.max(24, Math.floor((position.width - 24) / 7))))}</text>
    <text x="${position.x + 12}" y="${position.y + 35}" class="entity-count">${escapeHtml(countLabel)}</text>
    ${rows.join("\n")}
  </g>`;
}

function renderSvgRelationship(
  relationship: TableRelationship,
  positions: Map<string, { x: number; y: number; width: number; height: number }>,
  index: number
): string {
  const source = positions.get(entityKey(relationship.sourceSchema, relationship.sourceTable));
  const target = positions.get(entityKey(relationship.targetSchema, relationship.targetTable));
  if (!source || !target) {
    return "";
  }
  const sourceOnRight = target.x < source.x;
  const sourceX = sourceOnRight ? source.x : source.x + source.width;
  const sourceY = source.y + source.height / 2;
  const targetX = sourceOnRight ? target.x + target.width : target.x;
  const targetY = target.y + target.height / 2;
  const bend = Math.max(70, Math.abs(sourceX - targetX) / 2);
  const controlA = sourceOnRight ? targetX + bend : targetX - bend;
  const controlB = sourceOnRight ? sourceX - bend : sourceX + bend;
  const label = relationship.constraintName ?? relationship.relationType;
  const path = `M ${targetX} ${targetY} C ${controlA} ${targetY}, ${controlB} ${sourceY}, ${sourceX} ${sourceY}`;
  return `<g class="rel-group" data-relation="${index}" data-source="${escapeHtml(entityKey(relationship.sourceSchema, relationship.sourceTable))}" data-target="${escapeHtml(entityKey(relationship.targetSchema, relationship.targetTable))}">
    <title>${escapeHtml(label)}: ${escapeHtml(tableLabel(relationship.targetSchema, relationship.targetTable))} -> ${escapeHtml(tableLabel(relationship.sourceSchema, relationship.sourceTable))}</title>
    <path d="${path}" class="rel-hit"></path>
    <path d="${path}" class="rel-line" marker-end="url(#arrow)"></path>
  </g>`;
}

function renderRelationshipTable(relationships: TableRelationship[]): string {
  if (relationships.length === 0) {
    return `<p class="empty-state">No visible relationships matched this ER scope.</p>`;
  }
  const rows = relationships.map((relationship, index) => {
    const source = tableLabel(relationship.sourceSchema, relationship.sourceTable);
    const target = tableLabel(relationship.targetSchema, relationship.targetTable);
    const evidence = relationship.evidence.map((item) => item.detail).join(" ");
    return `<tr data-relation="${index}" data-source="${escapeHtml(entityKey(relationship.sourceSchema, relationship.sourceTable))}" data-target="${escapeHtml(entityKey(relationship.targetSchema, relationship.targetTable))}">
      <td>${escapeHtml(source)}.${escapeHtml(relationship.sourceColumns.join(","))}</td>
      <td>${escapeHtml(target)}.${escapeHtml(relationship.targetColumns.join(","))}</td>
      <td>${escapeHtml(relationship.relationType)}</td>
      <td>${relationship.confidence.toFixed(2)}</td>
      <td>${escapeHtml(evidence)}</td>
    </tr>`;
  }).join("");
  return `<table>
    <thead>
      <tr><th>Source</th><th>Target</th><th>Type</th><th>Confidence</th><th>Evidence</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderTableList(entities: ErEntity[]): string {
  if (entities.length === 0) {
    return `<p class="empty-state">No visible tables.</p>`;
  }
  return `<ul class="table-list">${entities.map((entity) => {
    const title = tableLabel(entity.schema, entity.table);
    const key = entityKey(entity.schema, entity.table);
    const pkCount = entity.columns.filter((column) => column.primaryKey).length;
    const indexedCount = entity.columns.filter((column) => column.indexed).length;
    return `<li>
      <button type="button" class="table-item" data-table="${escapeHtml(key)}" data-label="${escapeHtml(`${title} ${entity.columns.map((column) => column.name).join(" ")}`.toLowerCase())}">
        <span class="table-name">${escapeHtml(title)}</span>
        <span class="table-meta"><span>${entity.columns.length} columns</span>${pkCount ? `<span>${pkCount} PK</span>` : ""}${indexedCount ? `<span>${indexedCount} indexed</span>` : ""}</span>
      </button>
    </li>`;
  }).join("")}</ul>`;
}

function renderInspectorDefault(entities: ErEntity[], relationships: TableRelationship[]): string {
  if (entities.length === 0) {
    return `<p class="empty-state">No table is selected.</p>`;
  }
  const columnCount = entities.reduce((sum, entity) => sum + entity.columns.length, 0);
  const indexedTables = entities.filter((entity) => entity.columns.some((column) => column.indexed)).length;
  const pkTables = entities.filter((entity) => entity.columns.some((column) => column.primaryKey)).length;
  const connected = new Map<string, number>();
  for (const relationship of relationships) {
    const source = entityKey(relationship.sourceSchema, relationship.sourceTable);
    const target = entityKey(relationship.targetSchema, relationship.targetTable);
    connected.set(source, (connected.get(source) ?? 0) + 1);
    connected.set(target, (connected.get(target) ?? 0) + 1);
  }
  const topTables = Array.from(connected.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => {
      const entity = entities.find((item) => entityKey(item.schema, item.table) === key);
      const label = entity ? tableLabel(entity.schema, entity.table) : key;
      return `<li class="field-item"><div class="field-name">${escapeHtml(label)}</div><div class="field-type">${count} visible relationship(s)</div></li>`;
    })
    .join("");
  return `<div class="detail-title">Schema Overview</div>
    <div class="detail-meta">Select a table to inspect columns, keys, indexes, and direct relationships.</div>
    <div class="overview-grid">
      <div class="overview-stat"><span class="overview-value">${entities.length}</span><span class="overview-label">tables</span></div>
      <div class="overview-stat"><span class="overview-value">${relationships.length}</span><span class="overview-label">relationships</span></div>
      <div class="overview-stat"><span class="overview-value">${columnCount}</span><span class="overview-label">columns</span></div>
      <div class="overview-stat"><span class="overview-value">${pkTables}/${indexedTables}</span><span class="overview-label">PK / indexed tables</span></div>
    </div>
    ${topTables ? `<h3>Most Connected Tables</h3><ul class="field-list">${topTables}</ul>` : `<p class="empty-state">No visible relationships matched this ER scope.</p>`}`;
}

function renderInteractiveControls(): string {
  return `<button type="button" id="er-zoom-in">Zoom in</button>
    <button type="button" id="er-zoom-out">Zoom out</button>
    <button type="button" id="er-reset">Reset</button>
    <button type="button" id="er-fit">Fit</button>`;
}

function renderInteractiveScript(): string {
  return `<script>
(() => {
  const data = JSON.parse(document.getElementById("er-data").textContent || "{}");
  const wrap = document.querySelector(".svg-wrap");
  const canvas = document.getElementById("er-canvas");
  const nodes = Array.from(document.querySelectorAll("[data-node]"));
  const edges = Array.from(document.querySelectorAll("[data-source][data-target].rel-group"));
  const tableItems = Array.from(document.querySelectorAll("[data-table]"));
  const relationshipRows = Array.from(document.querySelectorAll("tr[data-source][data-target]"));
  const inspector = document.getElementById("er-inspector");
  const search = document.getElementById("er-search");
  const filterCount = document.getElementById("er-filter-count");
  const defaultInspectorHtml = inspector.innerHTML;
  let scale = 1;
  let focused = "";
  const entityByKey = new Map((data.entities || []).map((entity) => [tableKey(entity.schema, entity.table), entity]));
  const relationships = data.relationships || [];

  function tableKey(schema, table) {
    return ((schema || "") + "." + table).toLowerCase();
  }
  function tableName(entity) {
    return entity.schema ? entity.schema + "." + entity.table : entity.table;
  }
  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function setScale(next) {
    scale = Math.max(0.35, Math.min(2.2, next));
    wrap.style.transform = "scale(" + scale + ")";
    wrap.style.width = 100 / scale + "%";
  }
  function connectedKeys(key) {
    const keys = new Set([key]);
    relationships.forEach((relation) => {
      const source = tableKey(relation.sourceSchema, relation.sourceTable);
      const target = tableKey(relation.targetSchema, relation.targetTable);
      if (source === key || target === key) {
        keys.add(source);
        keys.add(target);
      }
    });
    return keys;
  }
  function relationMatchesKey(element, key) {
    return element.getAttribute("data-source") === key || element.getAttribute("data-target") === key;
  }
  function scrollNodeIntoView(key) {
    const node = nodes.find((item) => item.getAttribute("data-node") === key);
    if (!node) return;
    const x = Number(node.getAttribute("data-x") || 0) * scale;
    const y = Number(node.getAttribute("data-y") || 0) * scale;
    const width = Number(node.getAttribute("data-width") || 0) * scale;
    const height = Number(node.getAttribute("data-height") || 0) * scale;
    canvas.scrollTo({
      left: Math.max(0, x + width / 2 - canvas.clientWidth / 2),
      top: Math.max(0, y + height / 2 - canvas.clientHeight / 2),
      behavior: "smooth"
    });
  }
  function renderInspector(key) {
    const entity = entityByKey.get(key);
    if (!entity) {
      inspector.innerHTML = defaultInspectorHtml;
      return;
    }
    const direct = relationships.filter((relation) => tableKey(relation.sourceSchema, relation.sourceTable) === key || tableKey(relation.targetSchema, relation.targetTable) === key);
    const fields = (entity.columns || []).map((column) => {
      const badges = [
        column.primaryKey ? '<span class="badge key">PK</span>' : '',
        column.nullable === false ? '<span class="badge">NOT NULL</span>' : '',
        column.indexed ? '<span class="badge">IDX</span>' : ''
      ].join("");
      return '<li class="field-item"><div class="field-name">' + escape(column.name) + '</div><div class="field-type">' + escape(column.type || "") + '</div>' + badges + (column.comment ? '<div class="source-block">' + escape(column.comment) + '</div>' : '') + '</li>';
    }).join("");
    const rels = direct.length
      ? '<h3>Direct Relationships</h3><ul class="field-list">' + direct.map((relation) => {
          const source = (relation.sourceSchema ? relation.sourceSchema + "." : "") + relation.sourceTable;
          const target = (relation.targetSchema ? relation.targetSchema + "." : "") + relation.targetTable;
          const evidence = (relation.evidence || []).map((item) => item.detail).join(" ");
          return '<li class="field-item"><div class="field-name">' + escape(target) + ' -> ' + escape(source) + '</div><div class="field-type">' + escape((relation.constraintName || relation.relationType) + " / confidence " + Number(relation.confidence || 0).toFixed(2)) + '</div><div class="source-block">' + escape(evidence) + '</div></li>';
        }).join("") + '</ul>'
      : '<p class="empty-state">No direct relationship is visible for this table.</p>';
    inspector.innerHTML = '<div class="detail-title">' + escape(tableName(entity)) + '</div><div class="detail-meta">' + (entity.columns || []).length + ' column(s)</div><h3>Columns</h3><ul class="field-list">' + fields + '</ul>' + rels;
  }
  function focusTable(key) {
    focused = key || "";
    const connected = focused ? connectedKeys(focused) : new Set();
    nodes.forEach((node) => {
      const nodeKey = node.getAttribute("data-node");
      node.classList.toggle("active", Boolean(focused) && nodeKey === focused);
      node.classList.toggle("connected", Boolean(focused) && connected.has(nodeKey) && nodeKey !== focused);
      node.classList.toggle("dimmed", Boolean(focused) && !connected.has(nodeKey));
    });
    edges.forEach((edge) => {
      const active = Boolean(focused) && relationMatchesKey(edge, focused);
      edge.classList.toggle("connected", active);
      edge.classList.toggle("dimmed", Boolean(focused) && !active);
    });
    relationshipRows.forEach((row) => {
      const active = Boolean(focused) && relationMatchesKey(row, focused);
      row.style.background = active ? "var(--accent-soft)" : "";
    });
    tableItems.forEach((item) => item.classList.toggle("active", item.getAttribute("data-table") === focused));
    renderInspector(focused);
    if (focused) {
      scrollNodeIntoView(focused);
    }
  }
  function applySearch() {
    const value = (search.value || "").trim().toLowerCase();
    let visibleCount = 0;
    tableItems.forEach((item) => {
      const matched = !value || (item.getAttribute("data-label") || "").includes(value);
      item.closest("li").style.display = matched ? "" : "none";
      if (matched) visibleCount += 1;
    });
    if (filterCount) {
      filterCount.textContent = String(visibleCount);
    }
    nodes.forEach((node) => {
      const haystack = (node.getAttribute("data-label") || "") + " " + node.textContent.toLowerCase();
      const matched = !value || haystack.includes(value);
      node.classList.toggle("dimmed", Boolean(value) && !matched);
      node.classList.toggle("match", Boolean(value) && matched);
    });
    if (!value && focused) {
      focusTable(focused);
    }
  }
  nodes.forEach((node) => node.addEventListener("click", () => focusTable(node.getAttribute("data-node") || "")));
  tableItems.forEach((item) => item.addEventListener("click", () => focusTable(item.getAttribute("data-table") || "")));
  relationshipRows.forEach((row) => row.addEventListener("click", () => {
    focusTable(row.getAttribute("data-source") || "");
    row.scrollIntoView({ block: "nearest" });
  }));
  document.getElementById("er-zoom-in").addEventListener("click", () => setScale(scale + 0.1));
  document.getElementById("er-zoom-out").addEventListener("click", () => setScale(scale - 0.1));
  function fitToCanvas() {
    const svg = wrap.querySelector("svg");
    if (!svg) return;
    const width = Number(svg.getAttribute("width") || 1);
    const next = Math.max(0.35, Math.min(1, (canvas.clientWidth - 36) / width));
    setScale(next);
    canvas.scrollTo({ left: 0, top: 0 });
  }
  document.getElementById("er-fit").addEventListener("click", fitToCanvas);
  document.getElementById("er-reset").addEventListener("click", () => {
    search.value = "";
    focused = "";
    setScale(1);
    focusTable("");
    applySearch();
  });
  search.addEventListener("input", applySearch);
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let scrollLeft = 0;
  let scrollTop = 0;
  canvas.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) return;
    dragging = true;
    canvas.classList.add("dragging");
    startX = event.clientX;
    startY = event.clientY;
    scrollLeft = canvas.scrollLeft;
    scrollTop = canvas.scrollTop;
  });
  window.addEventListener("mousemove", (event) => {
    if (!dragging) return;
    canvas.scrollLeft = scrollLeft - (event.clientX - startX);
    canvas.scrollTop = scrollTop - (event.clientY - startY);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    canvas.classList.remove("dragging");
  });
  window.requestAnimationFrame(fitToCanvas);
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(1, maxLength - 3))}...`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptJson(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
