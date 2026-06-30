import assert from "node:assert/strict";
import test from "node:test";

import { isIpAllowed, validateAllowedIpRules } from "../dist/ip-policy.js";

test("isIpAllowed allows all when no source IP allowlist is configured", () => {
  assert.equal(isIpAllowed("203.0.113.10", []), true);
  assert.equal(isIpAllowed(undefined, []), true);
});

test("isIpAllowed matches exact IPv4, IPv6, and IPv4-mapped addresses", () => {
  assert.equal(isIpAllowed("203.0.113.10", ["203.0.113.10"]), true);
  assert.equal(isIpAllowed("203.0.113.11", ["203.0.113.10"]), false);
  assert.equal(isIpAllowed("::1", ["::1"]), true);
  assert.equal(isIpAllowed("::ffff:127.0.0.1", ["127.0.0.1"]), true);
});

test("isIpAllowed matches CIDR ranges", () => {
  assert.equal(isIpAllowed("10.2.3.4", ["10.0.0.0/8"]), true);
  assert.equal(isIpAllowed("192.0.2.10", ["10.0.0.0/8"]), false);
  assert.equal(isIpAllowed("2001:db8::42", ["2001:db8::/32"]), true);
});

test("validateAllowedIpRules rejects malformed entries", () => {
  assert.doesNotThrow(() => validateAllowedIpRules(["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"]));
  assert.throws(() => validateAllowedIpRules(["not-an-ip"]), /Invalid OB_MCP_ALLOWED_IPS/);
});
