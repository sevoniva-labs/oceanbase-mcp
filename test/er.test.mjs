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
  assert.match(compact, /\+ 2 more column\(s\)/);

  const detailed = renderErHtml(diagram, { format: "html-detailed", title: "Detailed ER" });
  assert.match(detailed, /Format: html-detailed/);
  assert.match(detailed, /order status/);
  assert.match(detailed, /PRIMARY/);
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
