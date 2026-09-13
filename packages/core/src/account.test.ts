/**
 * Pinning tests for `@zbase-protocol/core` cryptographic recipes.
 *
 * Two failure modes to guard against:
 *
 *   1. Anyone "simplifying" a recipe to something incompatible with the
 *      upstream Circom circuits (precommitment.circom etc.). Symptom is
 *      catastrophic: proofs continue to generate fine but the on-chain
 *      Groth16 verifier rejects them.
 *
 *   2. The two copies of these recipes (this package and
 *      `src/lib/privacy.ts` in the EVM frontend) drifting apart.
 *
 * The tests here intentionally use only *invariants* (not external
 * reference values) so they remain valid even if the underlying Poseidon
 * library updates. Cross-verification against `poseidon-lite` directly
 * is what pins the recipes to the circuit's expectations.
 *
 * Run:
 *   from packages/core: `npx tsx src/account.test.ts`
 *   or after `tsc`:    `node dist/account.test.js`
 */

import * as assert from "node:assert/strict";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import {
  computePrecommitment,
  computeCommitment,
  computeNullifierHash,
  computeLabel,
  feToBE32,
  SNARK_SCALAR_FIELD,
} from "./account.js";
import { buildMerkleTree, generateMerkleProof } from "./merkle.js";

// 1. Recipe identities: each helper must equal the bare circomlibjs
// expression on the same inputs (i.e., they're trivial wrappers). If
// anyone changes a recipe, this fails immediately.

assert.equal(
  computePrecommitment("0", "0"),
  poseidon2([0n, 0n]).toString(),
  "computePrecommitment(a,b) ≠ poseidon2([a,b])",
);
assert.equal(
  computePrecommitment("123", "456"),
  poseidon2([123n, 456n]).toString(),
  "computePrecommitment differs from poseidon2 on non-zero inputs",
);

assert.equal(
  computeNullifierHash("0"),
  poseidon1([0n]).toString(),
  "computeNullifierHash(n) ≠ poseidon1([n])",
);
assert.equal(
  computeNullifierHash("987"),
  poseidon1([987n]).toString(),
  "computeNullifierHash differs from poseidon1 on non-zero input",
);

assert.equal(
  computeCommitment("0", "0", "0"),
  poseidon3([0n, 0n, 0n]).toString(),
  "computeCommitment(v,l,pre) ≠ poseidon3([v,l,pre])",
);
assert.equal(
  computeCommitment("10", "20", "30"),
  poseidon3([10n, 20n, 30n]).toString(),
  "computeCommitment differs from poseidon3 on non-trivial inputs",
);

// 2. Argument order matters. The Circom circuit is precise about which
// argument lands in which Poseidon slot. If `computeCommitment` ever
// rearranges its args, the on-chain verifier rejects every proof.

assert.notEqual(
  computeCommitment("1", "2", "3"),
  computeCommitment("3", "2", "1"),
  "computeCommitment must not be symmetric across (value, precommitment)",
);
assert.notEqual(
  computeCommitment("1", "2", "3"),
  computeCommitment("2", "1", "3"),
  "computeCommitment must not be symmetric across (value, label)",
);
assert.notEqual(
  computePrecommitment("1", "2"),
  computePrecommitment("2", "1"),
  "computePrecommitment must not be symmetric across (nullifier, secret)",
);

// 3. label = keccak256(scope_be32 || nonce_be8) % SNARK_FIELD.
// Verify it's deterministic, in-range, and sensitive to both inputs.
{
  const l = BigInt(computeLabel("0", 0));
  assert.ok(l < SNARK_SCALAR_FIELD, "label must be reduced into the field");
  assert.equal(computeLabel("42", 7), computeLabel("42", 7), "label must be pure");
  assert.notEqual(computeLabel("42", 7), computeLabel("42", 8), "nonce must affect label");
  assert.notEqual(computeLabel("41", 7), computeLabel("42", 7), "scope must affect label");
}

// 4. feToBE32 round-trip + size check.
{
  const v = 0x1234567890abcdefn;
  const bytes = feToBE32(v);
  assert.equal(bytes.length, 32);
  assert.equal(bytes[31], 0xef);
  assert.equal(bytes[30], 0xcd);
  assert.equal(bytes[24], 0x12);
  for (let i = 0; i < 24; i++) {
    assert.equal(bytes[i], 0, `byte ${i} should be zero`);
  }
  let v2 = 0n;
  for (const b of bytes) v2 = (v2 << 8n) | BigInt(b);
  assert.equal(v2, v);
}

// 5. End-to-end composition. For a depositor with (nullifier=1, secret=2)
// who deposits value=10_000_000 in pool with scope=42 at nonce=7:
//   - precommitment = poseidon2([1,2])
//   - label = keccak256(scope_be32 || nonce_be8) % field
//   - commitment = poseidon3([value, label, precommitment])
// We confirm every piece is non-zero, in-range, and reproducible. This
// catches "silently returns 0" or "throws and we swallowed it" failure
// modes.
{
  const precommitment = computePrecommitment("1", "2");
  const label = computeLabel("42", 7);
  const commitment = computeCommitment("10000000", label, precommitment);

  assert.ok(BigInt(precommitment) > 0n, "precommitment cannot be 0");
  assert.ok(BigInt(label) > 0n, "label cannot be 0");
  assert.ok(BigInt(commitment) > 0n, "commitment cannot be 0");
  assert.ok(BigInt(commitment) < SNARK_SCALAR_FIELD, "commitment must fit field");
  assert.equal(
    commitment,
    computeCommitment("10000000", label, precommitment),
    "commitment must be deterministic",
  );
}

// 6. A one-leaf LeanIMT proof must use compacted index 0. lean-imt 2.2.3
// returned NaN here, which reached circom_runtime and made every fresh-pool
// withdrawal impossible to prove.
{
  const tree = buildMerkleTree([1n]);
  const proof = generateMerkleProof(tree, 0);
  assert.equal(proof.index, 0, "one-leaf compacted proof index must be 0");
  assert.equal(proof.actualDepth, 0, "one-leaf compacted proof depth must be 0");
}

console.log("zx402/core account.test.ts: all invariants hold");
