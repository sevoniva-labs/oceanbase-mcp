import assert from "node:assert/strict";
import test from "node:test";

import { verifyReadOnlyPermissions } from "../dist/db.js";

test("verifyReadOnlyPermissions accepts MySQL-compatible read-only grants", async () => {
  const pool = queryPool([
    { Grants: "GRANT USAGE ON *.* TO 'reader'@'%'" },
    { Grants: "GRANT SELECT, SHOW VIEW ON `app`.* TO 'reader'@'%'" }
  ]);

  const report = await verifyReadOnlyPermissions(pool, "mysql", 1_000);

  assert.equal(report.ok, true);
  assert.equal(report.severity, "pass");
  assert.deepEqual(report.writablePrivileges, []);
});

test("verifyReadOnlyPermissions flags MySQL-compatible write grants", async () => {
  const pool = queryPool([
    { Grants: "GRANT SELECT, UPDATE ON `app`.* TO 'reader'@'%'" },
    { Grants: "GRANT SELECT ON `app`.`orders` TO 'reader'@'%' WITH GRANT OPTION" }
  ]);

  const report = await verifyReadOnlyPermissions(pool, "mysql", 1_000);

  assert.equal(report.ok, false);
  assert.equal(report.severity, "fail");
  assert.deepEqual(report.writablePrivileges, ["GRANT OPTION", "UPDATE"]);
});

test("verifyReadOnlyPermissions accepts Oracle-compatible CREATE SESSION only", async () => {
  const pool = queryPool([{ PRIVILEGE: "CREATE SESSION" }]);

  const report = await verifyReadOnlyPermissions(pool, "oracle", 1_000);

  assert.equal(report.ok, true);
  assert.deepEqual(report.writablePrivileges, []);
});

test("verifyReadOnlyPermissions flags Oracle-compatible write privileges", async () => {
  const pool = queryPool([{ PRIVILEGE: "CREATE TABLE" }, { PRIVILEGE: "UPDATE ANY TABLE" }]);

  const report = await verifyReadOnlyPermissions(pool, "oracle", 1_000);

  assert.equal(report.ok, false);
  assert.deepEqual(report.writablePrivileges, ["CREATE TABLE", "UPDATE ANY TABLE"]);
});

function queryPool(rows) {
  return {
    async query() {
      return [rows, []];
    }
  };
}
