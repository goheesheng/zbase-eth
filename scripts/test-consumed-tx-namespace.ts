/**
 * Regression test for audit #5 — consumed-tx namespace collision.
 *
 * /authorize (facilitator access) and /user/upgrade (premium) both replay-protect
 * the same on-chain payment txHash. Before the fix they shared one key, so a
 * single payment consumed under one purpose blocked the other (user pays for
 * premium, an /authorize call burns the tx, user denied). The fix namespaces by
 * purpose. This test proves the SAME txHash under different purposes does NOT
 * collide, and the SAME purpose is still replay-protected.
 *
 * Runs against the in-memory fallback (no Upstash env), which mirrors the
 * production keyspace logic (purpose-prefixed keys).
 *
 * Run: npx tsx scripts/test-consumed-tx-namespace.ts
 */

import * as assert from "node:assert/strict";
import { tryConsumeTxHash } from "../src/lib/facilitator-authz";

const NET = "eip155:84532" as const;

let passed = 0;
async function ok(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  console.log("consumed-tx namespace — cross-purpose collision fix\n");

  await ok("THE BUG: same txHash under authz vs premium does NOT collide", async () => {
    const tx = "0xNAMESPACE_TEST_0001";
    const authzFirst = await tryConsumeTxHash(NET, tx, "authz");
    assert.equal(authzFirst, true, "first authz consume succeeds");
    // The SAME tx under a DIFFERENT purpose must still be consumable — the
    // premium endpoint must not be blocked by the authz consume.
    const premiumFirst = await tryConsumeTxHash(NET, tx, "premium");
    assert.equal(premiumFirst, true, "premium consume of the SAME tx must succeed (no cross-purpose collision)");
  });

  await ok("same purpose IS still replay-protected (authz twice → second fails)", async () => {
    const tx = "0xNAMESPACE_TEST_0002";
    assert.equal(await tryConsumeTxHash(NET, tx, "authz"), true, "first authz");
    assert.equal(await tryConsumeTxHash(NET, tx, "authz"), false, "replay of same tx+purpose must be rejected");
  });

  await ok("premium is also replay-protected within its own namespace", async () => {
    const tx = "0xNAMESPACE_TEST_0003";
    assert.equal(await tryConsumeTxHash(NET, tx, "premium"), true);
    assert.equal(await tryConsumeTxHash(NET, tx, "premium"), false);
  });

  await ok("default purpose is authz (back-compat for /authorize's no-arg call)", async () => {
    const tx = "0xNAMESPACE_TEST_0004";
    // No purpose = "authz". A subsequent explicit "authz" must see it as consumed.
    assert.equal(await tryConsumeTxHash(NET, tx), true, "default consume");
    assert.equal(await tryConsumeTxHash(NET, tx, "authz"), false, "explicit authz sees the default consume");
  });

  await ok("different networks don't collide (namespace includes network)", async () => {
    const tx = "0xNAMESPACE_TEST_0005";
    assert.equal(await tryConsumeTxHash("eip155:84532", tx, "authz"), true);
    assert.equal(await tryConsumeTxHash("eip155:8453", tx, "authz"), true, "same tx on a different network is independent");
  });

  console.log(`\n${passed} passed\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
