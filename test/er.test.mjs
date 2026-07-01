import assert from "node:assert/strict";
import test from "node:test";

import { buildErDiagram } from "../dist/er.js";

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
