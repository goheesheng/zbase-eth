/**
 * Fee-tier resolution — bills the HIGHER take, and the enterprise-zeroing guard.
 *
 * Model change (2026-07-10): standard + compliance now BOTH resolve to 500 bps
 * (single 5% tier; `compliance` is a deprecated alias). So the old
 * standard↔compliance "downgrade" is moot — they bill identically. What STILL
 * matters (and is asserted here) is that a 0-bps `enterprise` tier can never
 * zero out a paying tier: the bps comparison must pick the paying (5%) tier, not
 * enterprise. This is the AUDIT HIGH #3 invariant that must survive the collapse.
 *
 * We assert on the resolved BPS (via takeBpsFor), not the tier LABEL, because the
 * label is now ambiguous between two equal-priced tiers — the bps is what bills.
 *
 * Run: npx tsx scripts/test-fee-tier-resolution.ts
 */

import * as assert from "node:assert/strict";
import { resolveEffectiveFeeTier, takeBpsFor } from "../src/lib/facilitator-authz";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Resolved take in bps for a (provider, nullifier) pair. null tier → 0 bps.
function resolvedBps(p: Parameters<typeof resolveEffectiveFeeTier>[0], n: Parameters<typeof resolveEffectiveFeeTier>[1]): number {
  const t = resolveEffectiveFeeTier(p, n);
  return t ? takeBpsFor(t) : 0;
}

console.log("fee-tier resolution — single 5% tier + enterprise-zeroing guard\n");

ok("standard + compliance now bill IDENTICALLY (both 5% / 500 bps)", () => {
  // The old downgrade concern is moot — they resolve to the same take.
  assert.equal(takeBpsFor("standard"), 500);
  assert.equal(takeBpsFor("compliance"), 500);
  assert.equal(resolvedBps("standard", "compliance"), 500);
  assert.equal(resolvedBps("compliance", "standard"), 500);
});

ok("both standard → 5%", () => {
  assert.equal(resolvedBps("standard", "standard"), 500);
});

ok("provider only → provider's take", () => {
  assert.equal(resolvedBps("standard", null), 500);
});

ok("nullifier only → nullifier's take", () => {
  assert.equal(resolvedBps(null, "standard"), 500);
});

ok("both null → 0 bps (fee-free grace preserved)", () => {
  assert.equal(resolveEffectiveFeeTier(null, null), null);
  assert.equal(resolvedBps(null, null), 0);
});

ok("CRITICAL (AUDIT #3): enterprise (0 bps) does NOT zero out a paying tier", () => {
  // enterprise ranks highest but means 0 bps — comparing by bps, a paying tier
  // must win so the fee isn't wrongly zeroed. This is why we compare bps, not
  // TIER_RANK. Survives the single-tier collapse.
  assert.equal(resolvedBps("enterprise", "standard"), 500);
  assert.equal(resolvedBps("standard", "enterprise"), 500);
  assert.equal(resolvedBps("enterprise", "compliance"), 500);
});

console.log(`\n${passed} passed\n`);
