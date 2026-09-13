/**
 * Pinning tests for `@zbase-protocol/core` UTXO note primitives.
 *
 * Phase 1A guards the `planSpend` output-amount ordering, which downstream
 * callers (Agent C's withdraw/facilitator routes) bind to circuit signals
 * `outputCommitment[0]` (payment to recipient) and `outputCommitment[1]`
 * (change back to spender). Swapping these silently sends the change to
 * the recipient and burns the payment — same failure mode as the original
 * scaffold bug.
 *
 * Run:
 *   from packages/core: `npx tsx src/notes.test.ts`
 *   or after `tsc`:    `node dist/notes.test.js`
 */

import * as assert from "node:assert/strict";
import { poseidon2, poseidon3 } from "poseidon-lite";
import {
  createNote,
  createDummyNote,
  commitmentOf,
  npkOf,
  planSpend,
  consolidateNotes,
  NoteValueError,
  generateViewingKey,
  type Note,
} from "./notes.js";
import { deriveRecipientNPK, recoverViewingPKBlind } from "./npk.js";
import { SNARK_SCALAR_FIELD } from "./account.js";

const USDC = (n: number | bigint): bigint => BigInt(n) * 1_000_000n; // 6 decimals

// 1. Single-note path: $10 note pays $7, change $3.
{
  const ten = createNote(USDC(10), 1n);
  const { inputs, outputAmounts } = planSpend([ten], USDC(7));

  assert.equal(inputs[0], ten, "inputs[0] must be the $10 source note");
  assert.equal(inputs[1].amount, 0n, "inputs[1] must be a dummy (amount=0)");
  assert.equal(
    outputAmounts[0],
    USDC(7),
    "outputAmounts[0] must be the payment to the recipient",
  );
  assert.equal(
    outputAmounts[1],
    USDC(3),
    "outputAmounts[1] must be the change back to the spender",
  );
  assert.equal(
    outputAmounts[0] + outputAmounts[1],
    ten.amount,
    "value conservation: payment + change == input",
  );
}

// 2. Single-note exact-pay path: $10 note pays $10, change 0.
{
  const ten = createNote(USDC(10), 1n);
  const { outputAmounts } = planSpend([ten], USDC(10));
  assert.equal(outputAmounts[0], USDC(10), "exact pay: payment == input amount");
  assert.equal(outputAmounts[1], 0n, "exact pay: change == 0");
}

// 3. Two-note merge path: two $4 notes pay $7, change $1.
{
  const a = createNote(USDC(4), 1n);
  const b = createNote(USDC(4), 1n);
  const { inputs, outputAmounts } = planSpend([a, b], USDC(7));

  assert.equal(inputs[0].amount, USDC(4), "merge path: both inputs are real notes");
  assert.equal(inputs[1].amount, USDC(4), "merge path: both inputs are real notes");
  assert.equal(outputAmounts[0], USDC(7), "merge path: outputAmounts[0] is payment");
  assert.equal(outputAmounts[1], USDC(1), "merge path: outputAmounts[1] is change");
  assert.equal(
    outputAmounts[0] + outputAmounts[1],
    a.amount + b.amount,
    "merge path: value conservation",
  );
}

// 4. Insufficient balance throws (defensive — change should never be negative).
{
  const a = createNote(USDC(1), 1n);
  const b = createNote(USDC(1), 1n);
  assert.throws(
    () => planSpend([a, b], USDC(5)),
    NoteValueError,
    "planSpend must reject when even the two largest notes sum below payAmount",
  );
}

// 5. Empty available set throws.
{
  assert.throws(
    () => planSpend([], USDC(1)),
    NoteValueError,
    "planSpend must reject when no notes are available",
  );
}

// 6. Negative payAmount throws.
{
  const a = createNote(USDC(1), 1n);
  assert.throws(
    () => planSpend([a], -1n),
    NoteValueError,
    "planSpend must reject negative payAmount",
  );
}

console.log("zbase/core notes.test.ts: planSpend output ordering pinned");

// ── consolidateNotes (Phase 1C dust auto-merge) ──────────────────────────

// 7. At or below threshold: no consolidation needed.
{
  const notes = [createNote(USDC(1), 1n), createNote(USDC(2), 1n), createNote(USDC(3), 1n)];
  assert.equal(
    consolidateNotes(notes, 3),
    null,
    "consolidateNotes must return null when spendable count <= threshold",
  );
}

// 8. Above threshold: merges the two SMALLEST same-label notes, value-conserving.
{
  const notes = [
    createNote(USDC(10), 1n),
    createNote(USDC(1), 1n),
    createNote(USDC(5), 1n),
    createNote(USDC(2), 1n),
  ];
  const plan = consolidateNotes(notes, 3);
  assert.ok(plan, "4 notes > threshold 3 must produce a plan");
  assert.equal(plan!.inputs[0].amount, USDC(1), "smallest note merges first");
  assert.equal(plan!.inputs[1].amount, USDC(2), "second-smallest note merges first");
  assert.equal(plan!.outputAmounts[0], USDC(3), "merged output conserves value");
  assert.equal(plan!.outputAmounts[1], 0n, "second output slot is zero");
}

// 9. Zero-amount notes are unspendable noise — excluded from the count and the merge.
{
  const notes = [
    createNote(USDC(1), 1n),
    createNote(USDC(2), 1n),
    createDummyNote(),
    createDummyNote(),
  ];
  assert.equal(
    consolidateNotes(notes, 3),
    null,
    "dummies must not count toward the threshold",
  );
}

// 10. Labels never mix: a fragmented set where every label holds one note has no plan.
{
  const notes = [
    createNote(USDC(1), 1n),
    createNote(USDC(2), 2n),
    createNote(USDC(3), 3n),
    createNote(USDC(4), 4n),
  ];
  assert.equal(
    consolidateNotes(notes, 3),
    null,
    "consolidateNotes must never merge across ASP labels",
  );
}

// 11. Mixed labels: merges within the most-fragmented label group only.
{
  const notes = [
    createNote(USDC(9), 2n),
    createNote(USDC(1), 1n),
    createNote(USDC(3), 1n),
    createNote(USDC(7), 1n),
  ];
  const plan = consolidateNotes(notes, 3);
  assert.ok(plan, "must plan a merge inside the label-1 group");
  assert.equal(plan!.inputs[0].label, 1n, "merge stays inside one label");
  assert.equal(plan!.inputs[1].label, 1n, "merge stays inside one label");
  assert.equal(plan!.inputs[0].amount, USDC(1), "dust-first inside the group");
  assert.equal(plan!.inputs[1].amount, USDC(3), "dust-first inside the group");
}

// 12. Repeat-callable loop terminates and lands at the threshold.
{
  let notes: Note[] = [1, 2, 3, 4, 5, 6].map((v) => createNote(USDC(v), 1n));
  let rounds = 0;
  for (;;) {
    const plan = consolidateNotes(notes, 3);
    if (!plan) break;
    rounds += 1;
    assert.ok(rounds <= 10, "consolidation loop must terminate");
    const merged = createNote(plan.outputAmounts[0], plan.inputs[0].label);
    notes = notes.filter((n) => n !== plan.inputs[0] && n !== plan.inputs[1]);
    notes.push(merged);
  }
  assert.equal(notes.length, 3, "loop must stop exactly at the threshold");
  assert.equal(rounds, 3, "6 notes -> 3 notes takes exactly 3 merge rounds");
  assert.equal(
    notes.reduce((s, n) => s + n.amount, 0n),
    USDC(21),
    "total value is conserved across the whole consolidation loop",
  );
}

// 13. Bad threshold throws.
{
  assert.throws(
    () => consolidateNotes([createNote(USDC(1), 1n)], 0),
    NoteValueError,
    "threshold below 1 must throw",
  );
}

console.log("zbase/core notes.test.ts: consolidateNotes dust auto-merge pinned");

// ── C3: commitment recipe MUST match note_spend.circom (v1 Railgun NPK) ──────
// Circuit: NPK = Poseidon2(spendingPK, viewingPKBlind);
//          commitment = Poseidon3(amount, NPK, secret).
{
  const note: Note = {
    amount: USDC(7),
    label: 42n,
    spendingPK: 111n,
    viewingPKBlind: 222n,
    nullifier: 333n,
    secret: 444n,
  };

  // npkOf must equal Poseidon2(spendingPK, viewingPKBlind).
  const expectedNpk = poseidon2([note.spendingPK, note.viewingPKBlind]);
  assert.equal(npkOf(note), expectedNpk, "npkOf must match circuit NpkBuilder");

  // commitmentOf must equal Poseidon3(amount, NPK, secret) — NOT the old v0
  // recipe Poseidon3(amount, label, Poseidon2(nullifier, secret)).
  const expectedCommitment = poseidon3([note.amount, expectedNpk, note.secret]);
  assert.equal(
    commitmentOf(note),
    expectedCommitment,
    "commitmentOf must match circuit CommitmentHasher (v1 NPK recipe)",
  );

  // Guard against regressing to the v0 recipe.
  const v0Recipe = poseidon3([
    note.amount,
    note.label,
    poseidon2([note.nullifier, note.secret]),
  ]);
  assert.notEqual(
    commitmentOf(note),
    v0Recipe,
    "commitmentOf must NOT be the old v0 (label-based) recipe",
  );

  // label is NOT part of the commitment in v1: changing it must not change it.
  assert.equal(
    commitmentOf({ ...note, label: 999n }),
    commitmentOf(note),
    "label must not affect the v1 commitment",
  );

  // serialize round-trips the NPK fields (else encrypted notes lose them).
  const { serializeNote, deserializeNote } = await import("./notes.js");
  const round = deserializeNote(serializeNote(note));
  assert.equal(round.spendingPK, note.spendingPK, "serialize keeps spendingPK");
  assert.equal(round.viewingPKBlind, note.viewingPKBlind, "serialize keeps viewingPKBlind");
  assert.equal(commitmentOf(round), commitmentOf(note), "round-trip preserves commitment");
}

// ── C3: recipient NPK derivation (npk.ts) ────────────────────────────────────
// Verifies the Railgun-style derivation: spendingPK long-lived, viewingPKBlind a
// per-note ECDH blind the recipient can recover, and the resulting commitment
// matches the circuit recipe (commitmentOf) when used to build a Note.
{
  const recipientSpendingPubKey = 1234567890123456789n;
  const recipientView = generateViewingKey(); // X25519 keypair

  // Fixed ephemeral key → deterministic derivation (the test/witness-builder use).
  const ephPriv = new Uint8Array(32).fill(7);
  const d1 = deriveRecipientNPK({
    recipientViewingPubKey: recipientView.publicKey,
    recipientSpendingPubKey,
    ephemeralPrivateKey: ephPriv,
  });
  const d1again = deriveRecipientNPK({
    recipientViewingPubKey: recipientView.publicKey,
    recipientSpendingPubKey,
    ephemeralPrivateKey: ephPriv,
  });
  assert.equal(d1.spendingPK, d1again.spendingPK, "spendingPK deterministic for fixed ephemeral");
  assert.equal(d1.viewingPKBlind, d1again.viewingPKBlind, "viewingPKBlind deterministic for fixed ephemeral");

  // All three outputs are valid field elements / 32-byte key.
  assert.ok(d1.spendingPK >= 0n && d1.spendingPK < SNARK_SCALAR_FIELD, "spendingPK is a field element");
  assert.ok(d1.viewingPKBlind >= 0n && d1.viewingPKBlind < SNARK_SCALAR_FIELD, "viewingPKBlind is a field element");
  assert.equal(d1.ephemeralPublicKey.length, 32, "ephemeralPublicKey is 32 bytes");

  // spendingPK is long-lived: it does NOT depend on the ephemeral key.
  const ephPriv2 = new Uint8Array(32).fill(9);
  const d2 = deriveRecipientNPK({
    recipientViewingPubKey: recipientView.publicKey,
    recipientSpendingPubKey,
    ephemeralPrivateKey: ephPriv2,
  });
  assert.equal(d2.spendingPK, d1.spendingPK, "spendingPK constant across notes (long-lived)");
  // viewingPKBlind IS per-note: a different ephemeral → different blind → unlinkable.
  assert.notEqual(d2.viewingPKBlind, d1.viewingPKBlind, "viewingPKBlind differs per ephemeral (unlinkable)");

  // Recipient recovers the SAME viewingPKBlind from the published ephemeral pubkey.
  const recovered = recoverViewingPKBlind(recipientView.privateKey, d1.ephemeralPublicKey);
  assert.equal(recovered, d1.viewingPKBlind, "recipient recovers viewingPKBlind via ECDH");

  // The derived NPK builds a real, commitment-matching note: npkOf(note) ==
  // Poseidon2(spendingPK, viewingPKBlind) and commitmentOf is the v1 recipe.
  const note = createNote(USDC(5), 77n, {
    spendingPK: d1.spendingPK,
    viewingPKBlind: d1.viewingPKBlind,
  });
  assert.equal(
    npkOf(note),
    poseidon2([d1.spendingPK, d1.viewingPKBlind]),
    "npkOf(derived note) == Poseidon2(spendingPK, viewingPKBlind)",
  );
  assert.equal(
    commitmentOf(note),
    poseidon3([note.amount, poseidon2([d1.spendingPK, d1.viewingPKBlind]), note.secret]),
    "commitmentOf(derived note) matches the circuit recipe",
  );

  // A dummy / self-change note (no derivation) keeps NPK = 0 — still valid, just
  // not addressed to a third party.
  const dummy = createDummyNote();
  assert.equal(dummy.spendingPK, 0n, "dummy spendingPK stays 0");
  assert.equal(dummy.viewingPKBlind, 0n, "dummy viewingPKBlind stays 0");

  // Input validation: wrong-length keys + out-of-field spend pubkey throw.
  assert.throws(
    () => deriveRecipientNPK({ recipientViewingPubKey: new Uint8Array(31), recipientSpendingPubKey }),
    /32 bytes/,
    "rejects short viewing pubkey",
  );
  assert.throws(
    () =>
      deriveRecipientNPK({
        recipientViewingPubKey: recipientView.publicKey,
        recipientSpendingPubKey: SNARK_SCALAR_FIELD,
      }),
    /field element/,
    "rejects spend pubkey >= field modulus",
  );
}

console.log("zbase/core notes.test.ts: C3 commitment recipe matches note_spend.circom");
console.log("zbase/core notes.test.ts: C3 NPK derivation (npk.ts) verified");
