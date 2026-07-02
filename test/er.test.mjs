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
  assert.match(compact, /Format: html-compact/);
  assert.doesNotMatch(compact, /Mermaid Source/);
  assert.match(compact, /2 column\(s\)/);

  const detailed = renderErHtml(diagram, { format: "html-detailed", title: "Detailed ER" });
  assert.match(detailed, /Format: html-detailed/);
  assert.match(detailed, /order status/);
  assert.match(detailed, /PRIMARY/);
});

test("renderErHtml uses overview layout for large schemas", () => {
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
  const html = renderErHtml(diagram, { format: "html-interactive", title: "Large ER" });

  assert.match(html, /8-column overview layout \/ key fields first/);
  assert.match(html, /Showing up to 6 fields per table/);
  assert.match(html, /data-layout-columns="8"/);
  assert.match(html, /id="er-filter-count"/);
  assert.match(html, /Schema Overview/);
  assert.match(html, /Most Connected Tables/);
  assert.match(html, /scrollNodeIntoView/);
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
