/**
 * test-change-note-derivation.ts — the change note must be RE-DERIVABLE.
 *
 * Regression test for the 0.985 USDC lost on 2026-07-16.
 *
 * What happened: /api/withdraw generated the change note's nullifier/secret with
 * randomFieldElement(), returned them exactly once, and never persisted or logged
 * them (correctly — they are spend authority). A caller threw between the response
 * and its own write. The USDC is provably in the pool and no key to it exists
 * anywhere. ragequit cannot help: it needs those same secrets.
 *
 * The fix: /api/withdraw accepts optional nextNullifier/nextSecret. The circuit
 * takes them as PRIVATE inputs (withdraw/route.ts, circuitInputs) and does not care
 * whether they are random or derived. So a caller supplies them from its own seed
 * — deriveForwardingNote(mnemonic, i+1) — and a lost response becomes a retry
 * instead of a permanent loss.
 *
 * This file tests the derivation + validation contract WITHOUT a chain or a server:
 * the property that matters is "same seed + index => same note, forever."
 *
 * Run: npx tsx scripts/test-change-note-derivation.ts
 */
import * as assert from "node:assert/strict";
import {
  deriveForwardingNote,
  generateNewMnemonic,
  computePrecommitment,
} from "../packages/core/src/index.ts";

let failed = false;
const ok = (m: string) => console.log("  PASS: " + m);
const bad = (m: string) => { console.log("  FAIL: " + m); failed = true; };

console.log("change-note derivation — the 0.985 USDC regression\n");

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const mnemonic = generateNewMnemonic();

// 1. THE PROPERTY. This is the whole point: lose the response, re-derive the note.
{
  const first = deriveForwardingNote(mnemonic, 1);
  // ...client crashes, response is gone, process restarts, only the seed survives...
  const recovered = deriveForwardingNote(mnemonic, 1);
  assert.equal(recovered.nullifier, first.nullifier);
  assert.equal(recovered.secret, first.secret);
  assert.equal(recovered.precommitment, first.precommitment);
  ok("same seed + index => same change note (a lost response is a retry, not a loss)");
}

// 2. Distinct indices must not collide — else a second payment overwrites the first
//    note's identity and one of them becomes unspendable.
{
  const seen = new Set<string>();
  for (let i = 0; i < 16; i++) seen.add(deriveForwardingNote(mnemonic, i).nullifier);
  seen.size === 16 ? ok("16 indices => 16 distinct notes (no silent collisions)") : bad(`only ${seen.size}/16 distinct`);
}

// 3. Different seeds never collide.
{
  const a = deriveForwardingNote(mnemonic, 0);
  const b = deriveForwardingNote(generateNewMnemonic(), 0);
  a.nullifier !== b.nullifier ? ok("different seeds => different notes") : bad("seed collision");
}

// 4. Derived values must satisfy the SAME constraints the route enforces on
//    nextNullifier/nextSecret — otherwise the happy path 400s on its own output.
{
  const n = deriveForwardingNote(mnemonic, 3);
  const inField = (v: string) => /^[0-9]+$/.test(v) && BigInt(v) > 0n && BigInt(v) < SNARK_FIELD;
  inField(n.nullifier) ? ok("derived nullifier is a decimal field element in [1, p-1]") : bad("nullifier out of field");
  inField(n.secret) ? ok("derived secret is a decimal field element in [1, p-1]") : bad("secret out of field");
  n.nullifier !== n.secret ? ok("derived nullifier !== secret (route rejects equal pairs)") : bad("nullifier === secret");
}

// 5. The precommitment the route will compute from the supplied pair must equal the
//    one the wallet derived — if these ever diverge, the wallet scans for a
//    commitment the chain never contained and the note is invisible to recovery.
{
  const n = deriveForwardingNote(mnemonic, 5);
  const routeSide = computePrecommitment(n.nullifier, n.secret);
  assert.equal(routeSide.toString(), n.precommitment.toString());
  ok("poseidon2(nullifier, secret) matches the derived precommitment (recovery will find it)");
}

// 6. Sanity: the OLD behaviour is what unrecoverable looks like. Two random draws
//    never agree, so a lost response was terminal by construction.
{
  const rand = () => {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    let r = 0n;
    for (const x of b) r = (r << 8n) + BigInt(x);
    return r % SNARK_FIELD;
  };
  rand() !== rand() ? ok("random secrets are unrecoverable by definition (the old bug, demonstrated)") : bad("randomness broken");
}

console.log(failed ? "\nFAILED" : "\nCHANGE-NOTE DERIVATION: a lost response is now recoverable");
process.exit(failed ? 1 : 0);
