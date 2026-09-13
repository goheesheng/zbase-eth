/**
 * CRITICAL C3 regression test — FacilitatorClient baseUrl validation.
 *
 * settlePrivately sends the deposit's {nullifier, secret} (full spend authority)
 * to baseUrl. An http:// or malformed baseUrl leaks them to an on-path attacker.
 * The constructor now rejects unsafe URLs BEFORE any secret can be sent.
 *
 * Run: npx tsx src/facilitatorClient.test.ts   (from packages/core)
 */

import * as assert from "node:assert/strict";
import { assertSafeFacilitatorBaseUrl, createFacilitatorClient } from "./facilitatorClient.js";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("facilitatorClient — baseUrl safety guard (C3)\n");

ok("https URL is accepted", () => {
  assert.doesNotThrow(() => assertSafeFacilitatorBaseUrl("https://zbase.app"));
});

ok("http://localhost + 127.0.0.1 accepted (local dev)", () => {
  assert.doesNotThrow(() => assertSafeFacilitatorBaseUrl("http://localhost:3009"));
  assert.doesNotThrow(() => assertSafeFacilitatorBaseUrl("http://127.0.0.1:3009"));
});

ok("THE BUG: arbitrary http:// is REJECTED (would leak spend secrets)", () => {
  assert.throws(
    () => assertSafeFacilitatorBaseUrl("http://evil.example.com"),
    /insecure http/i,
    "a non-local http baseUrl must be refused — it would send spend secrets in cleartext",
  );
});

ok("insecure http allowed ONLY with explicit opt-in", () => {
  assert.throws(() => assertSafeFacilitatorBaseUrl("http://10.0.0.5:4020"));
  assert.doesNotThrow(() => assertSafeFacilitatorBaseUrl("http://10.0.0.5:4020", true));
});

ok("malformed / non-http protocol rejected", () => {
  assert.throws(() => assertSafeFacilitatorBaseUrl("not a url"));
  assert.throws(() => assertSafeFacilitatorBaseUrl("ftp://zbase.app"));
  assert.throws(() => assertSafeFacilitatorBaseUrl("file:///etc/passwd"));
});

ok("createFacilitatorClient throws on an unsafe baseUrl (constructor guard)", () => {
  assert.throws(() => createFacilitatorClient({ baseUrl: "http://evil.example.com" }), /insecure http/i);
  assert.doesNotThrow(() => createFacilitatorClient({ baseUrl: "https://zbase.app" }));
});

console.log(`\n${passed} passed\n`);
