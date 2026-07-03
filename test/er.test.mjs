import assert from "node:assert/strict";
import test from "node:test";

import { buildErDiagram, renderErDot, renderErHtml, renderErMarkdown, renderErPlantUml } from "../dist/er.js";

test("buildErDiagram renders Mermaid entities and relationships", () => {
  const diagram = buildErDiagram(
    "mysql",
    [
      {
        schema: "biz_test",
        table: "users",
        columns: [{ name: "id", type: "bigint", primaryKey: true, nullable: false }]
      },
      {
        schema: "biz_test",
        table: "orders",
        columns: [
          { name: "id", type: "bigint", primaryKey: true, nullable: false },
          { name: "user_id", type: "bigint", nullable: false }
        ]
      }
    ],
    [
      {
        relationType: "foreign_key",
        direction: "outbound",
        confidence: 1,
        sourceSchema: "biz_test",
        sourceTable: "orders",
        sourceColumns: ["user_id"],
        targetSchema: "biz_test",
        targetTable: "users",
        targetColumns: ["id"],
        constraintName: "fk_orders_user",
        depth: 1,
        evidence: [{ type: "foreign_key", detail: "test", columns: ["user_id"] }]
      }
    ]
  );

  assert.match(diagram.mermaid, /^erDiagram/);
  assert.match(diagram.mermaid, /biz_test_users/);
  assert.match(diagram.mermaid, /bigint id PK NOT_NULL/);
  assert.match(diagram.mermaid, /biz_test_users \|\|--o\{ biz_test_orders : "fk_orders_user"/);
});

test("renderErHtml supports compact and detailed formats", () => {
  const diagram = buildErDiagram(
    "mysql",
    [
      {
        schema: "biz_test",
        table: "orders",
        columns: [
          { name: "id", type: "bigint", primaryKey: true, nullable: false, indexed: true, indexNames: ["PRIMARY"], comment: "order id" },
          { name: "status", type: "varchar(32)", nullable: true, comment: "order status" }
        ]
      }
    ],
    []
  );

  const compact = renderErHtml(diagram, { format: "html-compact", title: "Compact ER" });
  assert.match(compact, /<link rel="icon" href="data:image\/svg\+xml/);
  assert.match(compact, /Format: html-compact/);
  assert.doesNotMatch(compact, /Mermaid Source/);
  assert.match(compact, /2 column\(s\)/);

  const detailed = renderErHtml(diagram, { format: "html-detailed", title: "Detailed ER" });
  assert.match(detailed, /Format: html-detailed/);
  assert.match(detailed, /order status/);
  assert.match(detailed, /PRIMARY/);
});

test("renderErHtml uses interactive graph map for large schemas", () => {
  const entities = Array.from({ length: 220 }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    return {
      schema: "large_demo",
      table: `order_domain_${suffix}`,
      columns: [
        { name: "id", type: "bigint", primaryKey: true, nullable: false, indexed: true, indexNames: ["PRIMARY"] },
        { name: `parent_${suffix}_id`, type: "bigint", nullable: false, indexed: true, indexNames: [`idx_parent_${suffix}`] },
        { name: "created_at", type: "datetime", nullable: false, indexed: true, indexNames: [`idx_created_${suffix}`] },
        { name: "status", type: "varchar(32)", nullable: false },
        { name: "amount", type: "decimal(18,2)", nullable: true },
        { name: "remark", type: "varchar(255)", nullable: true },
        { name: "payload", type: "json", nullable: true },
        { name: "extra_info", type: "varchar(255)", nullable: true }
      ]
    };
  });
  const relationships = entities.slice(1).map((entity, index) => ({
    relationType: "foreign_key",
    direction: "outbound",
    confidence: 1,
    sourceSchema: entity.schema,
    sourceTable: entity.table,
    sourceColumns: [`parent_${String(index + 2).padStart(3, "0")}_id`],
    targetSchema: "large_demo",
    targetTable: `order_domain_${String(index + 1).padStart(3, "0")}`,
    targetColumns: ["id"],
    constraintName: `fk_${String(index + 2).padStart(3, "0")}_${String(index + 1).padStart(3, "0")}`,
    depth: 1,
    evidence: [{ type: "foreign_key", detail: "Relationship comes from database metadata.", columns: ["parent_id"] }]
  }));
  const diagram = buildErDiagram("mysql", entities, relationships);
  const html = renderErHtml(diagram, {
    format: "html-interactive",
    title: "Large ER",
    warnings: ["Large schema warning", "Column limit warning"]
  });

  assert.ok(html.includes('id="er-map" aria-label="OceanBase ER graph"'));
  assert.ok(html.includes('id="er-graph-data"'));
  assert.ok(html.includes('data-relation-filter="confirmed" checked'));
  assert.ok(html.includes('data-relation-filter="probable" checked'));
  assert.ok(html.includes('data-relation-filter="possible"'));
  assert.ok(html.includes("Status: OK"));
  assert.ok(html.includes("Tables: 220"));
  assert.ok(html.includes('Visible relationships: <span id="er-visible-relationships">219</span>'));
  assert.ok(html.includes("Schema Overview"));
  assert.ok(html.includes("Diagnostics (2)"));
  assert.ok(html.includes("Large schema warning"));
  assert.ok(html.includes('"relationClass":"confirmed"'));
  assert.ok(html.includes("cytoscape("));
  assert.ok(html.includes('layout.on("layoutstop"'));
  assert.ok(html.includes('name: overviewLayout ? "grid" : "dagre"'));
  assert.ok(html.includes("cy.zoom(elements.nodes.length > 120 ? 0.48 : 0.62)"));
  assert.ok(html.includes("if (focusedNodeId && visibleNodeIds.has(focusedNodeId))"));
  assert.ok(html.includes("cy.fit(cy.elements(), 48)"));
  assert.doesNotMatch(html, /firstNode\.id\(\)/);
  assert.ok(html.includes("node.id === focusedNodeId ? ' active' : ''"));
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml/);
  assert.doesNotMatch(html, /container: map,\s*wheelSensitivity/s);
  assert.doesNotMatch(html, /wheelSensitivity:\s*0\.2/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
});

test("renderErHtml keeps Oracle and non-ASCII identifiers out of DOM ids", () => {
  const diagram = buildErDiagram(
    "oracle",
    [
      {
        schema: "APP",
        table: "订单-账户",
        columns: [
          { name: "ID", type: "NUMBER", primaryKey: true, nullable: false },
          { name: "用户_ID", type: "NUMBER", nullable: false, indexed: true, indexNames: ["IDX_ORDER_USER"] },
          { name: "备注<字段>", type: "VARCHAR2(200)", nullable: true, comment: "中文备注" }
        ],
        comment: "订单账户"
      },
      {
        schema: "APP",
        table: "USERS",
        columns: [
          { name: "ID", type: "NUMBER", primaryKey: true, nullable: false },
          { name: "NAME", type: "VARCHAR2(64)", nullable: true }
        ]
      },
      {
        schema: "APP",
        table: "PAYMENT$LOG",
        columns: [
          { name: "ID", type: "NUMBER", primaryKey: true, nullable: false },
          { name: "ORDER_ID", type: "NUMBER", nullable: false }
        ]
      },
      {
        schema: "APP",
        table: "AUDIT.LOG",
        columns: [
          { name: "ID", type: "NUMBER", primaryKey: true, nullable: false },
          { name: "ORDER_ID", type: "NUMBER", nullable: true }
        ]
      },
      {
        schema: "APP",
        table: "REF_STATUS",
        columns: [
          { name: "STATUS", type: "VARCHAR2(32)", primaryKey: true, nullable: false }
        ]
      }
    ],
    [
      {
        relationType: "foreign_key",
        direction: "outbound",
        confidence: 1,
        sourceSchema: "APP",
        sourceTable: "订单-账户",
        sourceColumns: ["用户_ID"],
        targetSchema: "APP",
        targetTable: "USERS",
        targetColumns: ["ID"],
        constraintName: "FK_ORDER_USER",
        depth: 1,
        evidence: [{ type: "foreign_key", detail: "Oracle foreign-key metadata.", columns: ["用户_ID"] }]
      },
      {
        relationType: "name_inference",
        direction: "outbound",
        confidence: 0.72,
        sourceSchema: "APP",
        sourceTable: "PAYMENT$LOG",
        sourceColumns: ["ORDER_ID"],
        targetSchema: "APP",
        targetTable: "订单-账户",
        targetColumns: ["ID"],
        depth: 1,
        evidence: [{ type: "naming", detail: "ORDER_ID matches the order primary key.", columns: ["ORDER_ID"] }]
      },
      {
        relationType: "name_inference",
        direction: "outbound",
        confidence: 0.42,
        sourceSchema: "APP",
        sourceTable: "AUDIT.LOG",
        sourceColumns: ["ORDER_ID"],
        targetSchema: "APP",
        targetTable: "订单-账户",
        targetColumns: ["ID"],
        depth: 1,
        evidence: [{ type: "naming", detail: "Weak ORDER_ID naming signal.", columns: ["ORDER_ID"] }]
      }
    ]
  );
  const html = renderErHtml(diagram, { format: "html-interactive", title: "Oracle ER" });
  const graph = JSON.parse(html.match(/<script type="application\/json" id="er-graph-data">([\s\S]*?)<\/script>/)[1]);

  assert.equal(graph.mode, "oracle");
  assert.equal(graph.summary.tableCount, 5);
  assert.equal(graph.summary.confirmedRelationships, 1);
  assert.equal(graph.summary.probableRelationships, 1);
  assert.equal(graph.summary.possibleRelationships, 1);
  assert.equal(graph.summary.hiddenRelationships, 1);
  assert(graph.nodes.every((node) => /^t_[a-f0-9]{14}$/.test(node.id)));
  assert(graph.edges.every((edge) => /^r_[a-f0-9]{14}$/.test(edge.id)));
  assert(graph.nodes.some((node) => node.label === "APP.订单-账户"));
  assert(graph.nodes.some((node) => node.label === "APP.AUDIT.LOG"));
  assert(graph.edges.some((edge) => edge.relationClass === "probable" && edge.visibleByDefault === true));
  assert(graph.edges.some((edge) => edge.relationClass === "possible" && edge.visibleByDefault === false));
  assert(graph.nodes.some((node) => node.comments.columns.some((column) => column.column === "备注<字段>" && column.comment === "中文备注")));
  assert.doesNotMatch(html, /id="APP\.订单-账户"/);
});

test("ER document renderers output Markdown PlantUML and DOT", () => {
  const diagram = buildErDiagram(
    "mysql",
    [
      {
        schema: "biz_test",
        table: "users",
        columns: [{ name: "id", type: "bigint", primaryKey: true, nullable: false }]
      },
      {
        schema: "biz_test",
        table: "orders",
        columns: [{ name: "user_id", type: "bigint", nullable: false, indexed: true, indexNames: ["idx_orders_user"] }]
      }
    ],
    [
      {
        relationType: "foreign_key",
        direction: "outbound",
        confidence: 1,
        sourceSchema: "biz_test",
        sourceTable: "orders",
        sourceColumns: ["user_id"],
        targetSchema: "biz_test",
        targetTable: "users",
        targetColumns: ["id"],
        constraintName: "fk_orders_user",
        depth: 1,
        evidence: [{ type: "foreign_key", detail: "Relationship comes from database metadata.", columns: ["user_id"] }]
      }
    ]
  );

  assert.match(renderErMarkdown(diagram, { title: "Order Model" }), /# Order Model/);
  assert.match(renderErMarkdown(diagram), /Relationship comes from database metadata/);
  assert.match(renderErPlantUml(diagram), /^@startuml/);
  assert.match(renderErPlantUml(diagram), /fk_orders_user/);
  assert.match(renderErDot(diagram), /^digraph oceanbase_er/);
  assert.match(renderErDot(diagram), /fk_orders_user/);
});
