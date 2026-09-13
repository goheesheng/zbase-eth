/**
 * @zbase-protocol/core — UTXO note primitives (Shipment A.1 scaffold)
 *
 * v0: in-memory note model + viewing-key encryption for storing notes off-chain
 * and posting their ciphertext alongside the spend's `NoteCommitted` event.
 *
 * Mirrors Railgun's note model (https://docs.railgun.org/wiki/learn/privacy-system).
 * The on-chain commitment encoding is intentionally identical to the current
 * single-value commitment in `account.ts` so the same Poseidon helpers stay in
 * use and the Anchor program's `crypto.rs` continues to apply without change:
 *
 *   precommitment = Poseidon2(nullifier, secret)
 *   commitment    = Poseidon3(amount, label, precommitment)
 *
 * Cryptographic envelope chosen for cold-start performance over libsodium.js
 * (no WASM init, no async load) — see /docs/utxo-notes-design.md §4.1.
 *
 *   * X25519 key agreement   (`@noble/curves/ed25519` → `x25519`)
 *   * XChaCha20-Poly1305     (`@noble/ciphers/chacha`)
 *   * 2-byte view-tag        (Railgun-style fast scan filter)
 *
 * Status: scaffold. Do NOT use the encryption helpers in production until
 * (a) the bytes layout has been pinned by a wallet review and
 * (b) the trusted-setup ceremony for `note_spend.circom` has completed.
 */

import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "@noble/hashes/utils";
// Shared, unbiased (rejection-sampling) field sampler — see account.ts (audit F7).
import { randomFieldElement, SNARK_SCALAR_FIELD } from "./account.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Plaintext note. Lives off-chain (in the wallet, in the facilitator's
 * per-user cache, or as the decrypted payload of a `NoteCommitted` log).
 *
 * v1 RECIPE (audit C3): the on-chain commitment recipe was migrated to match
 * the frozen `note_spend.circom`:
 *
 *   NPK        = Poseidon2(spendingPK, viewingPKBlind)
 *   commitment = Poseidon3(amount, NPK, secret)
 *
 * The previous v0 recipe `Poseidon3(amount, label, Poseidon2(nullifier,secret))`
 * did NOT match the circuit, so any UTXO proof the SDK built would have failed
 * verification. `label` is no longer part of the commitment (it now binds
 * privately through the NPK + the ASP-membership witness), but is retained on
 * the note because the circuit still proves ASP membership of `label`.
 *
 * ⚠️ AUDITOR-SCOPED GAP: this aligns the commitment HASH STRUCTURE with the
 * circuit. How `spendingPK` / `viewingPKBlind` are DERIVED from the recipient's
 * viewing key (the Railgun NPK key-derivation, and exactly how the ASP label is
 * folded into that derivation off-chain) is NOT yet implemented in the SDK and
 * must be designed + reviewed in the external circuit audit before the UTXO pool
 * goes live. Until then these are caller-supplied fields.
 */
export interface Note {
  /** USDC atomic units (6 decimal places). 0 marks a dummy / zero-note. */
  amount: bigint;
  /** ASP label inherited from the originating deposit. Proven for ASP
   *  membership; NOT part of the commitment in v1. */
  label: bigint;
  /** Recipient spending public key (field element) — NPK input. */
  spendingPK: bigint;
  /** Per-note blinded recipient viewing public key (field element) — NPK input. */
  viewingPKBlind: bigint;
  /** Per-note nullifier (random field element). */
  nullifier: bigint;
  /** Per-note secret (random field element). */
  secret: bigint;
}

/**
 * Viewing keypair. The private key gives read access to all notes addressed to
 * this owner; it cannot move funds (which require the per-note nullifier+secret).
 */
export interface ViewingKeyPair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array;  // 32 bytes (X25519)
}

/**
 * Encrypted note as it would appear on-chain inside a `NoteCommitted` log:
 *
 *   bytes layout:
 *     [0..32)   ephemeral X25519 public key
 *     [32..34)  2-byte view-tag (firstTwoBytes(keccak(shared)))
 *     [34..58)  XChaCha20 nonce (24 bytes)
 *     [58..)    AEAD ciphertext (plaintext_len + 16-byte Poly1305 tag)
 *
 * Total per-note overhead ≈ 58 + ciphertext_len. The plaintext is ~120-150
 * bytes after JSON serialization, putting per-note calldata cost at ~3K gas
 * (well under the ~250K Groth16 verification cost).
 */
export type EncryptedNote = Uint8Array;

// -----------------------------------------------------------------------------
// Note creation
// -----------------------------------------------------------------------------

/**
 * Create a fresh note with random nullifier + secret.
 *
 * `amount` + `label` come from a deposit or a parent note being split. The NPK
 * inputs (`spendingPK`, `viewingPKBlind`) identify the RECIPIENT and bind the
 * label privately — they default to 0 here for the self-spend / scaffold case,
 * but a real transfer MUST pass the recipient's derived NPK inputs.
 *
 * ⚠️ Deriving spendingPK/viewingPKBlind from a recipient's viewing key is the
 * auditor-scoped gap (see the Note doc). Until that lands, callers either pass
 * 0 (change-back-to-self placeholder) or supply explicit values.
 */
export function createNote(
  amount: bigint,
  label: bigint,
  npk?: { spendingPK: bigint; viewingPKBlind: bigint },
): Note {
  return {
    amount,
    label,
    spendingPK: npk?.spendingPK ?? 0n,
    viewingPKBlind: npk?.viewingPKBlind ?? 0n,
    nullifier: randomFieldElement(),
    secret: randomFieldElement(),
  };
}

/**
 * Create a zero-value dummy note. Used as a placeholder input/output to fill
 * the fixed N=2/M=2 slots of the v0 spend circuit when the spender does not
 * actually need 2 inputs or 2 outputs.
 *
 * A dummy carries amount=0 and label=0; the circuit's `inIsDummy[i]` flag
 * must be set to 1 for input dummies. (Output dummies are valid as-is because
 * a 0-amount output commitment hashes deterministically and inserts harmlessly
 * into the state tree — though wallets should treat amount=0 commitments as
 * unspendable noise.)
 */
export function createDummyNote(): Note {
  return {
    amount: 0n,
    label: 0n,
    spendingPK: 0n,
    viewingPKBlind: 0n,
    nullifier: randomFieldElement(),
    secret: randomFieldElement(),
  };
}

// -----------------------------------------------------------------------------
// Commitment + nullifier helpers — v1 Railgun NPK recipe (matches note_spend.circom)
// -----------------------------------------------------------------------------

/**
 * `NPK = Poseidon2(spendingPK, viewingPKBlind)`. The note-public-key the
 * circuit's `NpkBuilder` template computes (note_spend.circom NpkBuilder).
 */
export function npkOf(note: Pick<Note, "spendingPK" | "viewingPKBlind">): bigint {
  return poseidon2([note.spendingPK, note.viewingPKBlind]);
}

/**
 * v1 UTXO commitment (audit C3): `commitment = Poseidon3(amount, NPK, secret)`,
 * `NPK = Poseidon2(spendingPK, viewingPKBlind)`.
 *
 * This now matches `CommitmentHasher` in `note_spend.circom` EXACTLY (Poseidon3
 * over `[amount, npk, secret]`). The prior v0 recipe
 * `Poseidon3(amount, label, Poseidon2(nullifier, secret))` did NOT match the
 * circuit and would have made every UTXO proof unverifiable.
 *
 * NOTE: this is the UTXO-pool recipe. The legacy single-value pool keeps its own
 * (correct, deployed) recipe in `account.ts::computeCommitment` — do not unify
 * them; they back two different pools.
 */
export function commitmentOf(note: Note): bigint {
  const npk = npkOf(note);
  return poseidon3([note.amount, npk, note.secret]);
}

/**
 * `nullifierHash = Poseidon1(nullifier)`. Imported from account.ts. Repeated
 * here only for convenient note-centric API.
 */
export function nullifierHashOf(note: Note): bigint {
  return poseidon1([note.nullifier]) as bigint;
}

// -----------------------------------------------------------------------------
// Split / merge helpers (pure value arithmetic, no circuit invocation)
// -----------------------------------------------------------------------------

export class NoteValueError extends Error {}

/**
 * Circuit range bound (audit F11): `note_spend.circom` range-checks every output
 * amount and the withdrawn amount to 64 bits (`Num2Bits(64)`). Amounts at or
 * above 2^64 would fail proof generation with an opaque error, or — if a caller
 * skipped the SDK — risk field-wraparound creating value. We validate here so
 * bad amounts are rejected up front with a clear message.
 */
export const MAX_NOTE_AMOUNT = 1n << 64n;

/**
 * Split a single note into two new notes that conserve the parent value and
 * inherit its label. The two outputs are returned in the order
 * `[primary, change]`; pass them straight into a 2-output spend.
 */
export function splitNote(parent: Note, primaryAmount: bigint): [Note, Note] {
  if (primaryAmount < 0n) {
    throw new NoteValueError("splitNote: primaryAmount must be non-negative");
  }
  if (primaryAmount > parent.amount) {
    throw new NoteValueError(
      `splitNote: primaryAmount ${primaryAmount} > parent.amount ${parent.amount}`,
    );
  }
  // Carry the parent's NPK material so both children remain addressable to the
  // same owner (change-back-to-self semantics). A real outbound transfer
  // overrides the primary output's NPK with the recipient's at proof-build time.
  const npk = { spendingPK: parent.spendingPK, viewingPKBlind: parent.viewingPKBlind };
  return [
    createNote(primaryAmount, parent.label, npk),
    createNote(parent.amount - primaryAmount, parent.label, npk),
  ];
}

/**
 * Merge two notes (with matching label) into one. Returns the merged note.
 * The caller must spend the two inputs and mint this one output via a spend.
 */
export function mergeNotes(a: Note, b: Note): Note {
  if (a.label !== b.label) {
    throw new NoteValueError(
      "mergeNotes: labels must match (cannot mix ASP attestations across pools)",
    );
  }
  return createNote(a.amount + b.amount, a.label, {
    spendingPK: a.spendingPK,
    viewingPKBlind: a.viewingPKBlind,
  });
}

/**
 * Plan the inputs/outputs for paying `payAmount` out of an array of available
 * notes. Returns the (≤2) input notes and (≤2) output notes for a v0 spend.
 *
 * Strategy:
 *  - Pick the smallest single note ≥ payAmount if possible (minimises change).
 *  - Otherwise merge the two largest notes — error if their sum is still
 *    insufficient (caller must perform multiple spends; defer to a future
 *    "PaymentPlanner" helper).
 *
 * This is a v0 heuristic; production wallets should use a coin-selection
 * algorithm tuned for anonymity-set size (e.g., randomised LIFO).
 */
export function planSpend(
  available: readonly Note[],
  payAmount: bigint,
): { inputs: [Note, Note]; outputAmounts: [bigint, bigint] } {
  if (payAmount < 0n) {
    throw new NoteValueError("planSpend: payAmount must be non-negative");
  }
  if (payAmount >= MAX_NOTE_AMOUNT) {
    throw new NoteValueError(
      `planSpend: payAmount ${payAmount} exceeds the 64-bit circuit range bound`,
    );
  }
  if (available.length === 0) {
    throw new NoteValueError("planSpend: no notes available");
  }
  for (const n of available) {
    if (n.amount < 0n || n.amount >= MAX_NOTE_AMOUNT) {
      throw new NoteValueError(
        `planSpend: note amount ${n.amount} out of the valid 64-bit range`,
      );
    }
  }

  const single = [...available]
    .filter((n) => n.amount >= payAmount)
    .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];

  if (single) {
    const change = single.amount - payAmount;
    // Phase 1A: returns [payAmount, change] not [change, 0]; downstream binding to outputCommitment[0]/[1]
    return {
      inputs: [single, createDummyNote()],
      outputAmounts: [payAmount, change],
    };
  }

  const sorted = [...available].sort((a, b) =>
    a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0,
  );
  if (sorted.length < 2 || sorted[0].amount + sorted[1].amount < payAmount) {
    throw new NoteValueError(
      `planSpend: insufficient note balance for payment ${payAmount}`,
    );
  }
  const change = sorted[0].amount + sorted[1].amount - payAmount;
  // Phase 1A: returns [payAmount, change] not [change, 0]; downstream binding to outputCommitment[0]/[1]
  return {
    inputs: [sorted[0], sorted[1]],
    outputAmounts: [payAmount, change],
  };
}

/**
 * Plan one dust-consolidation step (Phase 1C operational fix).
 *
 * Fragmented wallets leak: every spend that has to merge two inputs reveals
 * (via the conservation law) that the spender held exactly those two note
 * values, and a wallet forced into many small spends produces a recognisable
 * on-chain cadence. Keeping the note count low ahead of time means real
 * payments can take the single-input path, which is the quietest shape.
 *
 * Given the available notes and a target count, returns the inputs/outputs
 * for ONE 2-in/1-out merge spend (the v0 circuit is fixed at 2×2, so a merge
 * consumes two notes and mints one; the second output slot carries 0):
 *
 *  - Only notes with amount > 0 count toward the threshold (zero-amount
 *    commitments are unspendable noise by convention — see createDummyNote).
 *  - Returns null when the spendable count is already ≤ threshold, or when
 *    no two spendable notes share a label (merging across labels would mix
 *    ASP attestations — same rule as mergeNotes).
 *  - Within the most-fragmented label group, the two SMALLEST notes merge
 *    first: dust is the priority, and small notes are the ones whose values
 *    are most identifiable in conservation-law analysis.
 *
 * Repeat-callable: apply the plan (spend the two inputs, keep the merged
 * output), then call again with the updated set. Each round reduces the
 * spendable count by exactly one, so looping until null terminates.
 */
export function consolidateNotes(
  available: readonly Note[],
  threshold = 3,
): { inputs: [Note, Note]; outputAmounts: [bigint, bigint] } | null {
  if (threshold < 1) {
    throw new NoteValueError("consolidateNotes: threshold must be >= 1");
  }

  const spendable = available.filter((n) => n.amount > 0n);
  if (spendable.length <= threshold) return null;

  // Group by label; only same-label notes can merge (ASP attestation rule).
  const byLabel = new Map<bigint, Note[]>();
  for (const n of spendable) {
    const group = byLabel.get(n.label);
    if (group) group.push(n);
    else byLabel.set(n.label, [n]);
  }

  // Pick the most-fragmented mergeable group; tie-break on smallest member
  // so the choice is deterministic for a given note set.
  let chosen: Note[] | null = null;
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    if (
      !chosen ||
      group.length > chosen.length ||
      (group.length === chosen.length && group[0].amount < chosen[0].amount)
    ) {
      chosen = group;
    }
  }
  if (!chosen) return null; // every label holds a single note — nothing merges

  const [a, b] = chosen;
  return {
    inputs: [a, b],
    outputAmounts: [a.amount + b.amount, 0n],
  };
}

// -----------------------------------------------------------------------------
// Serialization (off-chain wallet storage, not the on-chain encrypted form)
// -----------------------------------------------------------------------------

/**
 * Serialize a note to a compact JSON-friendly form. BigInts are encoded as
 * decimal strings; the round-trip is exact. Used for localStorage today; will
 * back the facilitator's encrypted note cache later.
 */
export function serializeNote(n: Note): string {
  return JSON.stringify({
    amount: n.amount.toString(),
    label: n.label.toString(),
    spendingPK: n.spendingPK.toString(),
    viewingPKBlind: n.viewingPKBlind.toString(),
    nullifier: n.nullifier.toString(),
    secret: n.secret.toString(),
  });
}

export function deserializeNote(s: string): Note {
  const o = JSON.parse(s) as {
    amount: string;
    label: string;
    spendingPK?: string;
    viewingPKBlind?: string;
    nullifier: string;
    secret: string;
  };
  const note: Note = {
    amount: BigInt(o.amount),
    label: BigInt(o.label),
    // Tolerate pre-v1 serialized notes (no NPK fields) by defaulting to 0 —
    // they predate the UTXO pool and never carried recipient NPK material.
    spendingPK: o.spendingPK !== undefined ? BigInt(o.spendingPK) : 0n,
    viewingPKBlind: o.viewingPKBlind !== undefined ? BigInt(o.viewingPKBlind) : 0n,
    nullifier: BigInt(o.nullifier),
    secret: BigInt(o.secret),
  };
  // HIGH fix (SDK audit 2026-07-09): RANGE-VALIDATE on deserialize. A corrupted /
  // malicious serialized note with an out-of-range amount (>= 2^64) or an
  // out-of-field element silently produces a commitment the circuit can never
  // accept → funds locked (or, unchecked, value-confusion). Reject early with a
  // clear error instead of failing opaquely at proof time.
  if (note.amount < 0n || note.amount >= MAX_NOTE_AMOUNT) {
    throw new NoteValueError(`deserializeNote: amount out of range [0, 2^64): ${note.amount}`);
  }
  for (const [name, v] of [
    ["label", note.label],
    ["nullifier", note.nullifier],
    ["secret", note.secret],
    ["spendingPK", note.spendingPK],
    ["viewingPKBlind", note.viewingPKBlind],
  ] as const) {
    if (v < 0n || v >= SNARK_SCALAR_FIELD) {
      throw new NoteValueError(`deserializeNote: ${name} is not a valid field element (>= SNARK field): ${v}`);
    }
  }
  return note;
}

// -----------------------------------------------------------------------------
// Viewing-key cryptography
// -----------------------------------------------------------------------------

/**
 * Generate a fresh X25519 viewing keypair. Private key is sampled from
 * `randomBytes` (= crypto.getRandomValues underneath). Curve constraints
 * (clamping) are handled by `x25519`'s scalar multiplication.
 */
export function generateViewingKey(): ViewingKeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Encrypt a note to a recipient's viewing public key.
 *
 * Returns the on-chain blob (see `EncryptedNote` layout above).
 *
 * Caveats:
 *  - The output is non-deterministic (ephemeral key + random nonce).
 *  - Includes a 2-byte view-tag to make recipient scanning O(N) trial-decrypt
 *    instead of O(N) full AEAD-decrypt.
 *  - Does NOT bind the ciphertext to any on-chain commitment. If you want
 *    AAD binding (preventing a malicious relayer from swapping ciphertexts
 *    between commitments) pass the commitment hash as `aad`.
 */
export function encryptNote(
  note: Note,
  recipientPublicKey: Uint8Array,
  aad?: Uint8Array,
): EncryptedNote {
  if (recipientPublicKey.length !== 32) {
    throw new Error("encryptNote: recipientPublicKey must be 32 bytes (X25519)");
  }

  // Ephemeral keypair
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);

  // Diffie-Hellman: shared = X25519(ephPriv, recipientPub)
  const shared = x25519.getSharedSecret(ephPriv, recipientPublicKey);

  // Symmetric key = keccak(shared) for domain separation from any other use
  // of `shared` (e.g., view-tag).
  const symKey = keccak_256(shared);

  // View-tag = first 2 bytes of keccak(0x01 || shared)
  // Domain-separated so a scanner can compute it without revealing it can also
  // produce the symKey.
  const viewTagInput = new Uint8Array(33);
  viewTagInput[0] = 0x01;
  viewTagInput.set(shared, 1);
  const viewTag = keccak_256(viewTagInput).slice(0, 2);

  // Nonce: 24 random bytes (XChaCha20)
  const nonce = randomBytes(24);

  const plaintext = new TextEncoder().encode(serializeNote(note));
  const cipher = xchacha20poly1305(symKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);

  // Assemble: [ephPub (32)][viewTag (2)][nonce (24)][ciphertext]
  const out = new Uint8Array(32 + 2 + 24 + ciphertext.length);
  out.set(ephPub, 0);
  out.set(viewTag, 32);
  out.set(nonce, 34);
  out.set(ciphertext, 58);
  return out;
}

/**
 * Attempt to decrypt a note using a viewing private key. Returns `null` on
 * view-tag mismatch (fast path: 99.998% of foreign notes reject here) or on
 * AEAD failure (cryptographically authenticated decryption).
 *
 * `aad` must match what the sender supplied at encryption time (commonly the
 * commitment hash as bytes).
 */
export function decryptNote(
  encrypted: EncryptedNote,
  viewingPrivateKey: Uint8Array,
  aad?: Uint8Array,
): Note | null {
  if (encrypted.length < 58 + 16) return null; // need at least the AEAD tag

  const ephPub = encrypted.slice(0, 32);
  const viewTag = encrypted.slice(32, 34);
  const nonce = encrypted.slice(34, 58);
  const ciphertext = encrypted.slice(58);

  const shared = x25519.getSharedSecret(viewingPrivateKey, ephPub);

  // Fast reject via view-tag.
  const viewTagInput = new Uint8Array(33);
  viewTagInput[0] = 0x01;
  viewTagInput.set(shared, 1);
  const expectedTag = keccak_256(viewTagInput).slice(0, 2);
  if (expectedTag[0] !== viewTag[0] || expectedTag[1] !== viewTag[1]) {
    return null;
  }

  const symKey = keccak_256(shared);
  const cipher = xchacha20poly1305(symKey, nonce, aad);
  let plaintext: Uint8Array;
  try {
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    // AEAD authentication failure — wrong key, corrupted blob, or wrong AAD.
    return null;
  }
  return deserializeNote(new TextDecoder().decode(plaintext));
}

/**
 * Scan an array of (commitment, encryptedNote) pairs and decrypt all notes
 * addressed to the viewing key. Convenience helper for the wallet/facilitator.
 *
 * `aadFor` allows AAD binding to the commitment (default: no AAD).
 */
export function scanNotes(
  entries: ReadonlyArray<{ commitment: bigint; encrypted: EncryptedNote }>,
  viewingPrivateKey: Uint8Array,
  aadFor?: (commitment: bigint) => Uint8Array | undefined,
): Array<{ commitment: bigint; note: Note }> {
  const out: Array<{ commitment: bigint; note: Note }> = [];
  for (const entry of entries) {
    const aad = aadFor ? aadFor(entry.commitment) : undefined;
    const note = decryptNote(entry.encrypted, viewingPrivateKey, aad);
    if (note) out.push({ commitment: entry.commitment, note });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Phase 1B: AAD-bound transfer encryption
// -----------------------------------------------------------------------------

/**
 * Encode a 256-bit field element as a 32-byte big-endian buffer. Mirrors
 * Solidity's `abi.encode(uint256)` layout exactly (32 bytes, MSB first,
 * zero-padded). Pulled in as a private helper so this module stays
 * dependency-free of `account.ts`'s on-chain encoding utilities.
 */
function uint256ToBE32(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error(`uint256ToBE32: value must be non-negative, got ${value}`);
  }
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v > 0n) {
    throw new Error("uint256ToBE32: value exceeds 256 bits");
  }
  return out;
}

/**
 * Build the AAD that binds a ciphertext to its on-chain commitment.
 *
 * Must match the value the UTXOPool contract verifies in `transfer()`:
 *
 *   aad = keccak256(abi.encode(outputCommitment))   (Solidity)
 *       = keccak256(uint256ToBE32(commitment))      (TypeScript, here)
 *
 * Returns the 32-byte keccak256 digest. Passing the bare commitment bytes
 * instead would still bind to the commitment but would NOT match the contract
 * — the on-chain hash is mandatory for the Phase 1B Fix 3 ciphertext-shuffle
 * defense to engage.
 */
export function commitmentAAD(commitment: bigint): Uint8Array {
  return keccak_256(uint256ToBE32(commitment));
}

/**
 * Convenience wrapper around `encryptNote` for the transfer use case.
 * Auto-derives the AAD from the commitment so callers can't accidentally
 * forget to bind. Equivalent to:
 *
 *   encryptNote(note, recipientPub, commitmentAAD(commitment))
 *
 * Use this everywhere the SDK builds `CommitmentCiphertext` for `transfer()`.
 */
export function encryptNoteForTransfer(
  note: Note,
  recipientViewingPubKey: Uint8Array,
  commitment: bigint,
): EncryptedNote {
  return encryptNote(note, recipientViewingPubKey, commitmentAAD(commitment));
}

/**
 * Decrypt a transfer-bound ciphertext, requiring the AAD to match the given
 * commitment. Returns `null` on:
 *
 *  - view-tag mismatch (fast path — not this key's note),
 *  - AEAD authentication failure (wrong key, corrupted blob),
 *  - AAD mismatch (relayer attempted to shuffle ciphertexts between
 *    commitments — Phase 1B Fix 3).
 *
 * Callers should ALWAYS use this in the scanner, never the bare `decryptNote`,
 * for `Transferred`-event ciphertexts. The bare form is reserved for legacy
 * `NoteCommitted` payloads (Shipment A.1 v0) which predate AAD binding.
 */
export function decryptNoteWithAAD(
  encrypted: EncryptedNote,
  viewingPrivateKey: Uint8Array,
  expectedCommitment: bigint,
): Note | null {
  return decryptNote(encrypted, viewingPrivateKey, commitmentAAD(expectedCommitment));
}

// -----------------------------------------------------------------------------
// On-chain ciphertext packing (UTXO transfer wire format)
// -----------------------------------------------------------------------------
//
// The on-chain `CommitmentCiphertext.ciphertext` field is a variable-length
// `bytes` (widened 2026-07-04 from Railgun's fixed `bytes32[4]`, which could not
// hold zBase's ~208-byte XChaCha20 envelope — see UTXOPool.sol). The contract
// does NOT parse these bytes; it only checks `aad`. So packing is an SDK↔scanner
// concern: we frame the raw `EncryptedNote` blob with a 1-byte version + a
// 4-byte big-endian length prefix, so the scanner can (a) reject a version it
// doesn't understand and (b) validate the payload arrived intact.
//
//   packed = [version:1][len:4 BE][EncryptedNote blob:len]
//
// This is deliberately NOT Railgun's fixed 4-word slotting — that assumes a
// fixed-size plaintext zBase doesn't have. A length-prefixed blob round-trips
// any envelope size and is forward-compatible.

/** Wire-format version for packed transfer ciphertexts. */
export const CIPHERTEXT_WIRE_VERSION = 1 as const;

/**
 * Frame an EncryptedNote for the on-chain `CommitmentCiphertext.ciphertext`
 * field. Returns a 0x-hex string ready to pass as Solidity `bytes`.
 */
export function packCiphertext(encrypted: EncryptedNote): `0x${string}` {
  if (!(encrypted instanceof Uint8Array) || encrypted.length === 0) {
    throw new Error("packCiphertext: EncryptedNote must be a non-empty Uint8Array");
  }
  if (encrypted.length > 0xffffffff) {
    throw new Error("packCiphertext: envelope too large");
  }
  const out = new Uint8Array(5 + encrypted.length);
  out[0] = CIPHERTEXT_WIRE_VERSION;
  const len = encrypted.length;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(encrypted, 5);
  let hex = "0x";
  for (const b of out) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

/**
 * Inverse of packCiphertext: recover the EncryptedNote blob from the on-chain
 * `bytes`. Returns null on malformed / wrong-version / length-mismatch input
 * (a scanner should skip, not throw, on a payload it can't parse).
 */
export function unpackCiphertext(packedHex: string): EncryptedNote | null {
  const hex = packedHex.startsWith("0x") ? packedHex.slice(2) : packedHex;
  if (hex.length % 2 !== 0 || hex.length < 10) return null; // need at least the 5-byte header
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i] = byte;
  }
  if (bytes[0] !== CIPHERTEXT_WIRE_VERSION) return null;
  const len = (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
  if (len <= 0 || 5 + len !== bytes.length) return null; // length must match exactly
  return bytes.slice(5);
}
