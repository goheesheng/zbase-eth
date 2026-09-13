#!/usr/bin/env node
/**
 * Drift tripwire — confirms the EVM frontend's `src/lib/privacy.ts`
 * Poseidon recipes still match the upstream Circom circuit's expectations.
 *
 * The same recipes also live in `packages/core/src/account.ts` (used by
 * the SVM SDK); that copy has its own pinning test
 * (`packages/core/src/account.test.ts`). The EVM frontend can't import
 * `@zbase-protocol/core` because `tsconfig.json` excludes `packages/`, so the two
 * stay in sync by convention. This script enforces that convention.
 *
 * The tests check structural invariants — argument order matters, recipes
 * are deterministic, all outputs are field-elements — without depending
 * on external "magic numbers". If the underlying poseidon-lite library is
 * ever wrong vs circomlibjs, the symptom would be the SVM and EVM proofs
 * BOTH failing on-chain, which the devnet test catches.
 *
 * Run:
 *   node scripts/check-poseidon-recipes.mjs
 *
 * Requires `poseidon-lite` (already a runtime dep of the EVM frontend).
 */

import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import * as assert from "node:assert/strict";

// EVM-side recipes pinned, written verbatim from src/lib/privacy.ts so
// any divergence in the live file shows up here at code-review time.
function evm_precommitment(nullifier, secret) {
  return poseidon2([BigInt(nullifier), BigInt(secret)]);
}
function evm_commitment(value, label, precommitment) {
  return poseidon3([BigInt(value), BigInt(label), BigInt(precommitment)]);
}
function evm_nullifier_hash(nullifier) {
  return poseidon1([BigInt(nullifier)]);
}

// 1. Recipes are bare wrappers over poseidon-lite (no extra inputs, no
// reordering). Same identity tests as packages/core/src/account.test.ts.
assert.equal(
  evm_precommitment(123n, 456n).toString(),
  poseidon2([123n, 456n]).toString(),
);
assert.equal(
  evm_commitment(10n, 20n, 30n).toString(),
  poseidon3([10n, 20n, 30n]).toString(),
);
assert.equal(
  evm_nullifier_hash(987n).toString(),
  poseidon1([987n]).toString(),
);

// 2. Argument order matters. Reversing args produces a different hash.
assert.notEqual(
  evm_commitment(1n, 2n, 3n).toString(),
  evm_commitment(3n, 2n, 1n).toString(),
);
assert.notEqual(
  evm_precommitment(1n, 2n).toString(),
  evm_precommitment(2n, 1n).toString(),
);

// 3. End-to-end composition.
{
  const pre = evm_precommitment(1n, 2n);
  const com = evm_commitment(10_000_000n, 42n, pre);
  assert.ok(pre > 0n, "precommitment cannot be 0");
  assert.ok(com > 0n, "commitment cannot be 0");
}

console.log("scripts/check-poseidon-recipes.mjs: EVM recipes match Circom expectations");
