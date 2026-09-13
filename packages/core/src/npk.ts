/**
 * @zbase-protocol/core — Recipient NPK derivation (audit C3).
 *
 * The v1 UTXO commitment is `Poseidon3(amount, NPK, secret)` where
 * `NPK = Poseidon2(spendingPK, viewingPKBlind)` (matches `note_spend.circom`
 * NpkBuilder + CommitmentHasher — see `notes.ts`). Phase 1A pinned the *hash
 * structure*; this module closes the remaining "auditor-scoped gap" noted in
 * `notes.ts`: HOW `spendingPK` / `viewingPKBlind` are DERIVED from a recipient's
 * published key material.
 *
 * ## Recipe (Railgun-style note-public-key)
 *
 *   spendingPK     = field(keccak("zBase/npk/spendingPK/v1" || recipientSpendPub))
 *   ephemeral      = fresh X25519 keypair (per note)
 *   shared         = X25519(ephemeralPriv, recipientViewingPub)
 *   viewingPKBlind = field(keccak("zBase/npk/viewingPKBlind/v1" || shared))
 *   NPK            = Poseidon2(spendingPK, viewingPKBlind)
 *
 * Two properties this buys:
 *
 *  1. **Unlinkability.** `viewingPKBlind` is a fresh ECDH blind per note, so two
 *     notes to the same recipient produce different NPKs → different commitments.
 *     An on-chain observer cannot cluster a recipient's incoming notes.
 *  2. **Recoverability.** The recipient publishes `ephemeralPublicKey` alongside
 *     the note (it already rides in the `encryptNote` blob — see `notes.ts`
 *     EncryptedNote layout, bytes [0..32)). With their viewing PRIVATE key they
 *     recompute the same `shared` → the same `viewingPKBlind` → the same NPK →
 *     the same commitment, confirming the note is theirs and that they can later
 *     prove `NPK = Poseidon2(spendingPK, viewingPKBlind)` in-circuit.
 *
 * `spendingPK` is long-lived (it identifies the recipient's spend authority and
 * is constant across their notes); only `viewingPKBlind` is per-note. This is the
 * standard Railgun split: the spending key authorizes movement, the blinded
 * viewing key provides per-note privacy.
 *
 * ## What this is NOT
 *
 * The recipient's `spendingPublicKey` is a field element the recipient publishes
 * (e.g., a Poseidon/Baby-Jubjub spend pubkey in a full wallet). zBase does not
 * yet ship a spending-key HD scheme (only the X25519 viewing key — see
 * `viewingKeyHD.ts`), so callers supply `recipientSpendingPubKey` explicitly.
 * Until a spending-key tree lands, a recipient MAY reuse a stable field element
 * (e.g., a hash of their viewing pubkey) as their spendingPK — at the cost of the
 * spend-authority separation, NOT of the per-note unlinkability (which comes from
 * the viewing blind). The derivation here is agnostic to that choice.
 *
 * ⚠️ AUDITOR NOTE: this is the SDK-side NPK derivation the circuit comment in
 * `note_spend.circom` (NpkBuilder) and `notes.ts` defer to the external audit.
 * The *circuit* only sees the resulting `NPK` field element; this module decides
 * how it is built off-chain. It must be reviewed before the UTXO pool goes live.
 */

import { x25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "@noble/hashes/utils";
import { SNARK_SCALAR_FIELD } from "./account.js";

// Domain-separation tags — keep each derivation distinct so no two keccak uses of
// the same input can collide (mirrors notes.ts's view-tag domain separation).
const DST_SPENDING_PK = "zBase/npk/spendingPK/v1";
const DST_VIEWING_BLIND = "zBase/npk/viewingPKBlind/v1";

/**
 * Reduce arbitrary bytes to a BN254 scalar-field element via a domain-separated
 * keccak, using DETERMINISTIC rejection sampling for a uniform result.
 *
 * audit-sweep-2026-06-17 (was a latent MED): the previous version did a naive
 * `keccak(...) % SNARK_SCALAR_FIELD` and a comment claimed the bias was
 * "< 2^-253". That was wrong by ~250 bits: r ≈ 2^253.6, so 2^256 / r = 5 with a
 * large remainder — the lowest ~29% of the field is over-represented, giving a
 * statistical distance of ~2^-4.2 (~5.4%), not 2^-253. For `spendingPK` (public
 * input) the bias is cosmetic, but `viewingPKBlind` is derived from a SECRET
 * (the X25519 shared secret), so a biased reduction on a secret-derived witness
 * is a real (if bounded) uniformity weakness. We now reject any digest in the
 * "extra" top band [LIMIT, 2^256) and re-hash with an incrementing counter byte,
 * so every accepted value is uniform over [0, r). The counter keeps it fully
 * deterministic — the recipient recomputes the identical element. Expected
 * iterations ≈ 1.25; the loop is bounded defensively.
 */
export function bytesToField(domain: string, bytes: Uint8Array): bigint {
  const tag = new TextEncoder().encode(domain);
  // Largest multiple of r that fits in 256 bits; digests >= LIMIT are rejected
  // so the accepted range maps uniformly onto [0, r).
  const TWO_256 = 1n << 256n;
  const LIMIT = TWO_256 - (TWO_256 % SNARK_SCALAR_FIELD);
  // 256 counter values is astronomically more than ever needed (P(reject) < 1/5
  // per try); throw rather than bias if somehow exhausted.
  for (let counter = 0; counter < 256; counter++) {
    const input = new Uint8Array(tag.length + bytes.length + 1);
    input.set(tag, 0);
    input.set(bytes, tag.length);
    input[tag.length + bytes.length] = counter; // domain ⊕ bytes ⊕ counter
    const h = keccak_256(input);
    let v = 0n;
    for (const byte of h) v = (v << 8n) | BigInt(byte);
    if (v < LIMIT) return v % SNARK_SCALAR_FIELD;
  }
  throw new Error("bytesToField: rejection sampling exhausted (unreachable)");
}

/** The NPK inputs plus the ephemeral pubkey the recipient needs to recover them. */
export interface DerivedNPK {
  /** Long-lived recipient spend authority, as a field element. */
  spendingPK: bigint;
  /** Per-note blinded viewing pubkey, as a field element. */
  viewingPKBlind: bigint;
  /**
   * Sender's per-note ephemeral X25519 public key (32 bytes). MUST be published
   * with the note so the recipient can recompute `viewingPKBlind`. In a transfer
   * this is the same ephemeral key `encryptNote` embeds; callers MAY pass that
   * key in via `ephemeralPrivateKey` to avoid generating two.
   */
  ephemeralPublicKey: Uint8Array;
}

export interface DeriveRecipientNPKParams {
  /**
   * Recipient's published viewing PUBLIC key (32-byte X25519). Same key used by
   * `encryptNote` to encrypt the note payload.
   */
  recipientViewingPubKey: Uint8Array;
  /**
   * Recipient's long-lived spending public key, as a field element. The caller
   * obtains this from the recipient's published address material. See the module
   * doc for the "reuse a stable field element" interim option.
   */
  recipientSpendingPubKey: bigint;
  /**
   * Optional: reuse a specific ephemeral private key (e.g., the one `encryptNote`
   * will use) so the note carries ONE ephemeral pubkey. If omitted, a fresh
   * 32-byte key is generated. MUST be 32 bytes.
   */
  ephemeralPrivateKey?: Uint8Array;
}

/**
 * Derive a recipient's NPK inputs for a fresh outbound note.
 *
 * Deterministic given (recipientViewingPubKey, recipientSpendingPubKey,
 * ephemeralPrivateKey): pass a fixed ephemeral key to get reproducible output
 * (used by tests + by the witness fixture builder). With no ephemeral key it is
 * non-deterministic (fresh per-note blind), which is the production default.
 */
export function deriveRecipientNPK(
  params: DeriveRecipientNPKParams,
): DerivedNPK {
  const { recipientViewingPubKey, recipientSpendingPubKey } = params;
  if (recipientViewingPubKey.length !== 32) {
    throw new Error(
      "deriveRecipientNPK: recipientViewingPubKey must be 32 bytes (X25519)",
    );
  }
  if (
    recipientSpendingPubKey < 0n ||
    recipientSpendingPubKey >= SNARK_SCALAR_FIELD
  ) {
    throw new Error(
      "deriveRecipientNPK: recipientSpendingPubKey must be a field element in [0, r)",
    );
  }
  const ephPriv = params.ephemeralPrivateKey ?? randomBytes(32);
  if (ephPriv.length !== 32) {
    throw new Error("deriveRecipientNPK: ephemeralPrivateKey must be 32 bytes");
  }
  const ephemeralPublicKey = x25519.getPublicKey(ephPriv);

  // spendingPK: long-lived, domain-separated reduction of the recipient's spend
  // pubkey into the field. Constant across the recipient's notes.
  const spendingPK = bytesToField(
    DST_SPENDING_PK,
    feToBE32(recipientSpendingPubKey),
  );

  // viewingPKBlind: per-note ECDH blind. shared = X25519(ephPriv, recipientView).
  const shared = x25519.getSharedSecret(ephPriv, recipientViewingPubKey);
  const viewingPKBlind = bytesToField(DST_VIEWING_BLIND, shared);

  return { spendingPK, viewingPKBlind, ephemeralPublicKey };
}

/**
 * Recipient-side recovery of `viewingPKBlind` from the published ephemeral
 * pubkey + the recipient's viewing PRIVATE key. Recomputes the same ECDH shared
 * secret the sender used, so the recipient can reconstruct the NPK (and hence the
 * commitment) and confirm the note is addressed to them.
 *
 *   shared = X25519(viewingPriv, ephemeralPub)   // == sender's X25519(ephPriv, viewingPub)
 *   viewingPKBlind = field(keccak(DST || shared))
 */
export function recoverViewingPKBlind(
  viewingPrivateKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): bigint {
  if (viewingPrivateKey.length !== 32) {
    throw new Error("recoverViewingPKBlind: viewingPrivateKey must be 32 bytes");
  }
  if (ephemeralPublicKey.length !== 32) {
    throw new Error(
      "recoverViewingPKBlind: ephemeralPublicKey must be 32 bytes",
    );
  }
  const shared = x25519.getSharedSecret(viewingPrivateKey, ephemeralPublicKey);
  return bytesToField(DST_VIEWING_BLIND, shared);
}

/**
 * Big-endian 32-byte encoding of a field element. Local copy of `account.ts`'s
 * `feToBE32` value semantics (kept here to avoid a string round-trip — account's
 * takes string|bigint and returns via a different path) so the spendingPK
 * reduction has a fixed-width, canonical input.
 */
function feToBE32(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("feToBE32: value must be non-negative");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("feToBE32: value exceeds 32 bytes");
  return out;
}
