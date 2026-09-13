/**
 * Fund-safety tests for D3 deterministic forwarding notes.
 *
 * The forwarding rail lets a relayer deposit on the user's behalf. Two invariants
 * are LOAD-BEARING — a break in either loses user funds:
 *
 *   1. DETERMINISM: the same mnemonic + index always derives the same
 *      (nullifier, secret, precommitment). If this ever varies, the relayer
 *      deposits at a commitment the user can never re-derive → funds locked.
 *   2. RECOVERABILITY: a note whose precommitment the relayer deposited must be
 *      findable by scan-by-commitment from the seed alone (no shared index).
 *
 * Plus: the relayer must NOT be able to spend (it only ever holds the
 * precommitment, never the seed-derived secret).
 *
 * Run:
 *   from packages/core: `npx tsx src/forwardingNotes.test.ts`
 */

import * as assert from "node:assert/strict";
import { poseidon2, poseidon3 } from "poseidon-lite";
import {
  deriveForwardingNote,
  precommitmentForRelayer,
  recoverForwardingNotes,
  ZBASE_FORWARDING_PATH_PREFIX,
} from "./forwardingNotes.js";
import { computeCommitment, computeLabel, SNARK_SCALAR_FIELD } from "./account.js";

// A fixed test mnemonic (NEVER a real wallet — 12-word all-"abandon" BIP39 vector).
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("forwardingNotes — fund-safety invariants\n");

// ── INVARIANT 1: DETERMINISM ────────────────────────────────────────────────
ok("same mnemonic + index → identical note every time", () => {
  const a = deriveForwardingNote(MNEMONIC, 0);
  const b = deriveForwardingNote(MNEMONIC, 0);
  assert.equal(a.nullifier, b.nullifier);
  assert.equal(a.secret, b.secret);
  assert.equal(a.precommitment, b.precommitment);
  assert.equal(a.derivationPath, `${ZBASE_FORWARDING_PATH_PREFIX}/0`);
});

ok("different indices derive different notes", () => {
  const n0 = deriveForwardingNote(MNEMONIC, 0);
  const n1 = deriveForwardingNote(MNEMONIC, 1);
  assert.notEqual(n0.nullifier, n1.nullifier);
  assert.notEqual(n0.secret, n1.secret);
  assert.notEqual(n0.precommitment, n1.precommitment);
});

ok("nullifier and secret are distinct (domain separation works)", () => {
  const n = deriveForwardingNote(MNEMONIC, 0);
  assert.notEqual(n.nullifier, n.secret);
});

ok("derived field elements are in-range (< SNARK field)", () => {
  for (let i = 0; i < 5; i++) {
    const n = deriveForwardingNote(MNEMONIC, i);
    assert.ok(BigInt(n.nullifier) < SNARK_SCALAR_FIELD);
    assert.ok(BigInt(n.secret) < SNARK_SCALAR_FIELD);
    assert.ok(BigInt(n.nullifier) > 0n);
    assert.ok(BigInt(n.secret) > 0n);
  }
});

// ── INVARIANT: precommitment matches the circuit ground-truth ───────────────
ok("precommitment == Poseidon2(nullifier, secret) (circuit ground-truth)", () => {
  const n = deriveForwardingNote(MNEMONIC, 3);
  const expected = poseidon2([BigInt(n.nullifier), BigInt(n.secret)]).toString();
  assert.equal(n.precommitment, expected);
});

ok("precommitmentForRelayer matches the full derivation", () => {
  const n = deriveForwardingNote(MNEMONIC, 7);
  assert.equal(precommitmentForRelayer(MNEMONIC, 7), n.precommitment);
});

// ── RELAYER CANNOT SPEND ────────────────────────────────────────────────────
ok("the relayer's precommitment reveals nothing usable to spend", () => {
  // The relayer only ever gets `precommitment`. To spend, it needs (nullifier,
  // secret). Poseidon2 is preimage-resistant, so possessing the precommitment
  // does not yield the secrets. We assert the relayer's view (precommitment) is
  // NOT equal to either secret — i.e. we never accidentally hand over a secret.
  const n = deriveForwardingNote(MNEMONIC, 0);
  assert.notEqual(n.precommitment, n.nullifier);
  assert.notEqual(n.precommitment, n.secret);
});

// ── INVARIANT 2: RECOVERABILITY (scan-by-commitment) ────────────────────────
ok("recoverForwardingNotes finds notes the relayer deposited, from the seed alone", () => {
  // Simulate: the relayer deposited at indices 0, 1, 2. On-chain, each produced a
  // Deposited event with commitment = Poseidon3(value, label, precommitment). The
  // (value, label) are chosen on-chain — we simulate them here.
  const scope = "12345";
  const events = [0, 1, 2].map((i) => {
    const note = deriveForwardingNote(MNEMONIC, i);
    const value = String(1_000_000 - i); // arbitrary post-fee values
    const label = computeLabel(scope, i);
    const commitment = computeCommitment(value, label, note.precommitment);
    return { commitment, label, value };
  });

  const recovered = recoverForwardingNotes(MNEMONIC, events, 10 /* scan window past last */);
  assert.equal(recovered.length, 3, "should recover exactly the 3 deposited notes");
  // Each recovered note must carry the spend secrets AND the on-chain value/label.
  for (const r of recovered) {
    assert.ok(r.nullifier && r.secret, "recovered note missing spend secrets");
    // The recovered commitment must re-derive from the note's own precommitment.
    assert.equal(computeCommitment(r.value, r.label, r.precommitment), r.commitment);
  }
});

ok("recovery tolerates index gaps (a skipped index doesn't break later ones)", () => {
  const scope = "999";
  // Only indices 0 and 3 landed on-chain (1, 2 skipped).
  const events = [0, 3].map((i) => {
    const note = deriveForwardingNote(MNEMONIC, i);
    const value = "500000";
    const label = computeLabel(scope, i);
    return { commitment: computeCommitment(value, label, note.precommitment), label, value };
  });
  const recovered = recoverForwardingNotes(MNEMONIC, events, 10);
  assert.equal(recovered.length, 2, "should find both non-contiguous notes");
});

ok("a different mnemonic recovers NONE of the notes (no cross-seed collision)", () => {
  const scope = "777";
  const events = [0, 1].map((i) => {
    const note = deriveForwardingNote(MNEMONIC, i);
    const value = "1000000";
    const label = computeLabel(scope, i);
    return { commitment: computeCommitment(value, label, note.precommitment), label, value };
  });
  const OTHER =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const recovered = recoverForwardingNotes(OTHER, events, 10);
  assert.equal(recovered.length, 0, "a foreign seed must not recover another user's notes");
});

// ── input validation ────────────────────────────────────────────────────────
ok("negative / non-integer index rejected", () => {
  assert.throws(() => deriveForwardingNote(MNEMONIC, -1));
  assert.throws(() => deriveForwardingNote(MNEMONIC, 1.5));
});

console.log(`\n${passed} passed\n`);
