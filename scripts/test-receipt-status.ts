/**
 * Regression test for audit HIGH-2 — postman receipt.status check.
 *
 * A mined-but-REVERTED tx resolves waitForTransactionReceipt with
 * status="reverted". The shared EOA postman path used to ignore status and
 * return success → callers (forwarding deposit, withdraw relay, settle) treated
 * a reverted tx as confirmed, stranding funds + suppressing retries. The fix
 * asserts status==="success". This tests the extracted invariant directly.
 *
 * Run: npx tsx scripts/test-receipt-status.ts
 */

import * as assert from "node:assert/strict";
import { assertReceiptSucceeded } from "../src/lib/postman-signer";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("postman receipt.status — reverted-tx guard\n");

ok("status 'success' → does NOT throw (happy path)", () => {
  assert.doesNotThrow(() => assertReceiptSucceeded("success", "0xok"));
});

ok("THE BUG: status 'reverted' → THROWS (was silently treated as confirmed)", () => {
  assert.throws(
    () => assertReceiptSucceeded("reverted", "0xbad"),
    /reverted on-chain/,
    "a reverted tx must throw so the caller retries instead of stranding funds",
  );
});

ok("any non-success status throws (defensive against unexpected values)", () => {
  for (const s of ["", "pending", "failed", "unknown"]) {
    assert.throws(() => assertReceiptSucceeded(s, "0x"), /reverted on-chain/, `status='${s}' must throw`);
  }
});

ok("the txHash is included in the error (operator can find the reverted tx)", () => {
  try {
    assertReceiptSucceeded("reverted", "0xDEADBEEF");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /0xDEADBEEF/);
  }
});

console.log(`\n${passed} passed\n`);
