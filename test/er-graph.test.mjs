import assert from "node:assert/strict";
import test from "node:test";

import { buildErGraph, classifyErRelationship, erGraphNodeId } from "../dist/er-graph.js";

test("buildErGraph creates stable ids separate from display labels", () => {
  const entities = [
    {
      schema: "业务库",
      table: "订单中心_001",
      comment: "订单主表",
      rowEstimate: { value: 1000000, exact: false, source: "information_schema.tables" },
      columns: [
        { name: "id", type: "bigint", primaryKey: true, nullable: false, indexed: true, indexNames: ["PRIMARY"] },
        { name: "用户_id", type: "bigint", nullable: false, indexed: true, indexNames: ["idx_user"] },
        { name: "备注<测试>", type: "varchar(64)", nullable: true, comment: "特殊字符" }
      ]
    },
    {
      schema: "业务库",
      table: "用户中心",
      columns: [
        { name: "id", type: "bigint", primaryKey: true, nullable: false, indexed: true, indexNames: ["PRIMARY"] }
      ]
    }
  ];
  const relationships = [
    {
      relationType: "name_inference",
      direction: "outbound",
      confidence: 0.68,
      sourceSchema: "业务库",
      sourceTable: "订单中心_001",
      sourceColumns: ["用户_id"],
      targetSchema: "业务库",
      targetTable: "用户中心",
      targetColumns: ["id"],
      depth: 1,
      evidence: [
        { type: "naming", detail: "Column 用户_id follows naming convention.", columns: ["用户_id"] },
        { type: "index", detail: "Source column 用户_id is indexed.", columns: ["用户_id"] }
      ]
    }
  ];

  const graph = buildErGraph("mysql", entities, relationships);

  assert.equal(graph.status, "OK");
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].id, erGraphNodeId("mysql", "业务库", "订单中心_001"));
  assert.match(graph.nodes[0].id, /^t_[a-f0-9]{14}$/);
  assert.equal(graph.nodes[0].label, "业务库.订单中心_001");
  assert.equal(graph.nodes[0].domain, "订单中心");
  assert.equal(graph.nodes[0].primaryKeys[0], "id");
  assert.equal(graph.nodes[0].indexes.length, 2);
  assert.equal(graph.nodes[0].comments.table, "订单主表");
  assert.equal(graph.nodes[0].comments.columns[0].comment, "特殊字符");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relationClass, "probable");
  assert.equal(graph.edges[0].visibleByDefault, true);
  assert.equal(graph.summary.probableRelationships, 1);
});

test("buildErGraph hides low-confidence possible relationships by default", () => {
  const entities = [
    { schema: "biz", table: "orders", columns: [{ name: "id", type: "bigint", primaryKey: true }] },
    { schema: "biz", table: "accounts", columns: [{ name: "id", type: "bigint", primaryKey: true }] }
  ];
  const relationship = {
    relationType: "name_inference",
    direction: "outbound",
    confidence: 0.55,
    sourceSchema: "biz",
    sourceTable: "orders",
    sourceColumns: ["account_id"],
    targetSchema: "biz",
    targetTable: "accounts",
    targetColumns: ["id"],
    depth: 1,
    evidence: [{ type: "naming", detail: "Weak naming evidence.", columns: ["account_id"] }]
  };

  const graph = buildErGraph("mysql", entities, [relationship]);

  assert.equal(classifyErRelationship(relationship), "possible");
  assert.equal(graph.edges[0].visibleByDefault, false);
  assert.equal(graph.summary.hiddenRelationships, 1);
  assert.equal(graph.diagnostics[0].code, "possible_relationships_hidden");
});

test("buildErGraph classifies database constraints as confirmed", () => {
  const relationship = {
    relationType: "foreign_key",
    direction: "outbound",
    confidence: 1,
    sourceSchema: "BIZ",
    sourceTable: "ORDERS",
    sourceColumns: ["USER_ID"],
    targetSchema: "BIZ",
    targetTable: "USERS",
    targetColumns: ["ID"],
    constraintName: "FK_ORDERS_USERS",
    depth: 1,
    evidence: [{ type: "foreign_key", detail: "Database metadata.", columns: ["USER_ID"] }]
  };

  const graph = buildErGraph(
    "oracle",
    [
      { schema: "BIZ", table: "ORDERS", columns: [{ name: "USER_ID", type: "NUMBER", indexed: true }] },
      { schema: "BIZ", table: "USERS", columns: [{ name: "ID", type: "NUMBER", primaryKey: true }] }
    ],
    [relationship]
  );

  assert.equal(classifyErRelationship(relationship), "confirmed");
  assert.equal(graph.edges[0].relationClass, "confirmed");
  assert.equal(graph.edges[0].sourceRule, "foreign_key");
  assert.equal(graph.summary.confirmedRelationships, 1);
});
