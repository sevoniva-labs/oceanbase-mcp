import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";
import { createObMcpServer } from "../dist/mcp.js";

test("query plan tools run EXPLAIN for read-only MySQL SQL", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const pool = explainPool();
  const server = createObMcpServer(runtime(config, pool));

  const explainResult = await server.executeToolHandler(server._registeredTools.ob_explain, {
    sql: "SELECT id FROM biz_test.orders WHERE status = ? ORDER BY created_at",
    params: ["PAID"]
  }, {});
  const explain = JSON.parse(explainResult.content[0].text);

  assert.equal(explain.rowCount, 1);
  assert.equal(pool.explainCalls, 1);

  const analysisResult = await server.executeToolHandler(server._registeredTools.ob_analyze_query_plan, {
    sql: "SELECT id FROM biz_test.orders WHERE status = ? ORDER BY created_at",
    params: ["PAID"]
  }, {});
  const analysis = JSON.parse(analysisResult.content[0].text);

  assert.equal(analysis.analysis.riskLevel, "high");
  assert(analysis.analysis.findings.some((finding) => finding.rule === "full_scan"));
  assert(analysis.analysis.findings.some((finding) => finding.rule === "sort_or_temp"));
  assert.equal(pool.explainCalls, 2);
});

test("performance report uses EXPLAIN and visible metadata without DDL advice", async () => {
  const config = loadConfig({
    OB_ALLOWED_SCHEMAS: "biz_test",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const pool = performancePool();
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_generate_performance_report, {
    sql: "SELECT id FROM biz_test.orders WHERE status = ?",
    params: ["PAID"]
  }, {});
  const output = JSON.parse(result.content[0].text);
  const text = JSON.stringify(output);

  assert.equal(output.executed, false);
  assert.equal(output.report.riskLevel, "high");
  assert.equal(output.tables[0].schema, "biz_test");
  assert.equal(output.tables[0].table, "orders");
  assert.equal(output.tables[0].stats.rowEstimate.value, 250000);
  assert.equal(output.tables[0].indexRows, 1);
  assert.equal(pool.explainCalls, 1);
  assert.equal(pool.targetSqlExecuted, false);
  assert.doesNotMatch(text, /\bCREATE\s+INDEX\b/i);
});

test("query plan tools accept Oracle named binds through positional params", async () => {
  const config = loadConfig({
    OB_COMPATIBILITY: "oracle",
    OB_ALLOWED_SCHEMAS: "APP",
    OB_ENFORCE_READ_ONLY_TX: "false",
    OB_MAX_ROWS: "20"
  });
  const pool = {
    async query({ sql, values }) {
      assert.equal(sql, "EXPLAIN SELECT ID FROM APP.ORDERS WHERE STATUS = ?");
      assert.deepEqual(values, ["PAID"]);
      return [[{ OPERATOR: "TABLE ACCESS FULL", NAME: "ORDERS", ROWS: 1000 }], []];
    }
  };
  const server = createObMcpServer(runtime(config, pool));

  const result = await server.executeToolHandler(server._registeredTools.ob_analyze_query_plan, {
    sql: "SELECT ID FROM APP.ORDERS WHERE STATUS = :status",
    params: ["PAID"]
  }, {});
  const output = JSON.parse(result.content[0].text);

  assert.equal(output.analysis.riskLevel, "high");
  assert(output.analysis.findings.some((finding) => finding.rule === "full_scan"));
});

function runtime(config, pool) {
  return {
    defaultProfile: "default",
    configs: { default: config },
    pools: { default: pool },
    queryLimiters: { default: { active: 0, limit: 5 } }
  };
}

function explainPool() {
  return {
    explainCalls: 0,
    async query({ sql, values }) {
      assert.match(sql, /^EXPLAIN\s+SELECT id FROM biz_test\.orders/i);
      assert.deepEqual(values, ["PAID"]);
      this.explainCalls += 1;
      return [[{
        id: 1,
        select_type: "SIMPLE",
        table: "orders",
        type: "ALL",
        Extra: "Using where; Using filesort"
      }], []];
    }
  };
}

function performancePool() {
  return {
    explainCalls: 0,
    targetSqlExecuted: false,
    async query({ sql, values = [] }) {
      if (/^SELECT id FROM biz_test\.orders/i.test(sql)) {
        this.targetSqlExecuted = true;
        throw new Error("Target SQL should not run");
      }
      if (/^EXPLAIN\s+SELECT id FROM biz_test\.orders/i.test(sql)) {
        assert.deepEqual(values, ["PAID"]);
        this.explainCalls += 1;
        return [[{
          id: 1,
          select_type: "SIMPLE",
          table: "orders",
          type: "ALL",
          Extra: "Using where"
        }], []];
      }
      if (/FROM information_schema\.tables/i.test(sql)) {
        return [[{
          table_schema: "biz_test",
          table_name: "orders",
          table_rows: 250000,
          data_length: 1048576,
          index_length: 131072,
          update_time: "2026-01-01 00:00:00"
        }], []];
      }
      if (/COUNT\(\*\) AS item_count FROM information_schema\.columns/i.test(sql)) {
        return [[{ item_count: 6 }], []];
      }
      if (/COUNT\(DISTINCT index_name\) AS item_count FROM information_schema\.statistics/i.test(sql)) {
        return [[{ item_count: 1 }], []];
      }
      if (/COUNT\(DISTINCT constraint_name\) AS item_count FROM information_schema\.table_constraints/i.test(sql)) {
        return [[{ item_count: 1 }], []];
      }
      if (/FROM information_schema\.partitions/i.test(sql)) {
        return [[{ item_count: 0 }], []];
      }
      if (/FROM information_schema\.statistics/i.test(sql)) {
        return [[{
          table_schema: "biz_test",
          table_name: "orders",
          index_name: "idx_orders_status",
          non_unique: 1,
          seq_in_index: 1,
          column_name: "status",
          index_type: "BTREE"
        }], []];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}
