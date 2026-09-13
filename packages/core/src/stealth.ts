/**
 * @zbase-protocol/core — ERC-5564 stealth addresses (scheme id 1, secp256k1)
 *
 * Implements the canonical ERC-5564 scheme 1 ("secp256k1-1") as deployed by
 * ScopeLift / Umbra / Fluidkey, the same scheme audited by Trail of Bits.
 * Spec: https://eips.ethereum.org/EIPS/eip-5564
 *
 * The scheme:
 *   - Provider holds two secp256k1 keypairs: spending (k_s, K_s) and viewing (k_v, K_v).
 *   - Meta-address encodes the two compressed public keys as
 *       st:<chain>:0x<spendingPubKey:33B><viewingPubKey:33B>      // 132 hex chars
 *   - For each payment the facilitator (sender) generates a fresh ephemeral
 *     keypair (r, R = r·G), computes the ECDH shared point S = r · K_v,
 *     hashes it: s_h = keccak256(S_compressed). The view tag is s_h[0].
 *   - The stealth public key is P = K_s + s_h · G. The stealth Ethereum
 *     address is the standard keccak256(uncompressed-pub-key-without-prefix)[12:].
 *   - The provider scans Announcement events, recomputes S = k_v · R for
 *     each ephemeral pubkey, checks the view tag, and (on match) derives the
 *     stealth private key as k = (k_s + s_h) mod n.
 *
 * Why this matters: today every payment to OpenAI's x402 endpoint pays the
 * same address; an outside observer maps "wallet X pays Nansen every 60s".
 * After this ship, every payment to the same provider lands on a different
 * stealth address derived from their registered meta-address — the buyer
 * sees a single endpoint, the chain sees N unrelated recipients.
 *
 * Security boundary: the viewing private key never leaves the provider.
 * An attacker who controls the facilitator AND knows the viewing key can
 * correlate ephemeralPubkey → stealth recipient. Without the viewing key,
 * the link is computationally hidden by the discrete-log assumption on
 * secp256k1 (same assumption Ethereum signatures rely on).
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** ERC-5564 scheme identifier. Only scheme 1 (secp256k1 + keccak256) is supported. */
export const STEALTH_SCHEME_ID = 1 as const;

/** Default chain tag used in meta-address URIs ("st:<chain>:0x..."). */
export const DEFAULT_CHAIN_TAG = "base";

export interface StealthMetaAddress {
  /** "st:base:0x<spendingPubKey:33B><viewingPubKey:33B>" */
  metaAddress: string;
  /** Hex-encoded compressed public key (66 hex chars, with 0x prefix). */
  spendingPublicKey: string;
  /** Hex-encoded compressed public key (66 hex chars, with 0x prefix). */
  viewingPublicKey: string;
}

export interface StealthMetaAddressWithPrivate extends StealthMetaAddress {
  /** Provider-only. Required to compute stealth private keys; NEVER share. */
  spendingPrivateKey: string;
  /** Provider-only. Required to scan; can be delegated to a view-only scanner. */
  viewingPrivateKey: string;
}

export interface DerivedStealthAddress {
  /** 0x-prefixed 20-byte Ethereum address. */
  stealthAddress: string;
  /** Hex-encoded compressed ephemeral public key R = r·G (66 hex chars). */
  ephemeralPublicKey: string;
  /** 1 byte (2 hex chars), most-significant byte of the hashed shared secret. */
  viewTag: string;
}

export interface ScanMatch {
  /** Index into the input `recentEphemeralPubkeys` array. */
  index: number;
  /** The ephemeral pubkey that produced this match (echoed back for convenience). */
  ephemeralPublicKey: string;
  /** The stealth Ethereum address derived from this ephemeral pubkey. */
  stealthAddress: string;
  /** The view tag observed for this ephemeral pubkey. */
  viewTag: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-side: meta-address generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a fresh ERC-5564 meta-address from an optional seed.
 *
 * The seed is intentionally optional: passing a deterministic seed enables
 * reproducible tests; omitting it pulls 64 bytes of OS randomness. Either
 * way, both keys live for the life of the provider — they are NOT rotated
 * per call.
 *
 * @param seed Optional 64-byte Uint8Array. First 32 bytes seed the spending
 *   key, last 32 bytes seed the viewing key. If omitted, secure random.
 */
export function generateMetaAddress(
  seed?: Uint8Array,
  chainTag: string = DEFAULT_CHAIN_TAG,
): StealthMetaAddressWithPrivate {
  let spendingPrivateKey: Uint8Array;
  let viewingPrivateKey: Uint8Array;

  if (seed) {
    if (seed.length !== 64) {
      throw new Error(`stealth: seed must be exactly 64 bytes, got ${seed.length}`);
    }
    spendingPrivateKey = clampToCurve(seed.slice(0, 32));
    viewingPrivateKey = clampToCurve(seed.slice(32, 64));
  } else {
    spendingPrivateKey = secp256k1.utils.randomPrivateKey();
    viewingPrivateKey = secp256k1.utils.randomPrivateKey();
  }

  const spendingPublicKey = secp256k1.getPublicKey(spendingPrivateKey, true);
  const viewingPublicKey = secp256k1.getPublicKey(viewingPrivateKey, true);

  const metaAddress =
    `st:${chainTag}:0x${bytesToHex(spendingPublicKey)}${bytesToHex(viewingPublicKey)}`;

  return {
    metaAddress,
    spendingPublicKey: "0x" + bytesToHex(spendingPublicKey),
    viewingPublicKey: "0x" + bytesToHex(viewingPublicKey),
    spendingPrivateKey: "0x" + bytesToHex(spendingPrivateKey),
    viewingPrivateKey: "0x" + bytesToHex(viewingPrivateKey),
  };
}

/**
 * Parse a "st:<chain>:0x<spending:33B><viewing:33B>" meta-address URI.
 * Accepts either the full URI or a bare 0x-prefixed 132-hex-char string.
 */
export function parseMetaAddress(metaAddress: string): {
  chainTag: string;
  spendingPublicKey: Uint8Array;
  viewingPublicKey: Uint8Array;
} {
  let chainTag = DEFAULT_CHAIN_TAG;
  let raw: string;

  if (metaAddress.startsWith("st:")) {
    const parts = metaAddress.split(":");
    if (parts.length !== 3) {
      throw new Error(`stealth: malformed meta-address URI: ${metaAddress}`);
    }
    chainTag = parts[1];
    raw = parts[2];
  } else {
    raw = metaAddress;
  }

  if (raw.startsWith("0x")) raw = raw.slice(2);
  if (raw.length !== 132) {
    throw new Error(
      `stealth: meta-address payload must be 132 hex chars (got ${raw.length})`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error("stealth: meta-address payload must be hex");
  }

  const spendingPublicKey = hexToBytes(raw.slice(0, 66));
  const viewingPublicKey = hexToBytes(raw.slice(66));

  if (!isValidCompressedPubKey(spendingPublicKey)) {
    throw new Error("stealth: spendingPublicKey is not a valid compressed secp256k1 point");
  }
  if (!isValidCompressedPubKey(viewingPublicKey)) {
    throw new Error("stealth: viewingPublicKey is not a valid compressed secp256k1 point");
  }

  return { chainTag, spendingPublicKey, viewingPublicKey };
}

/**
 * Quick sniff test: is this string an ERC-5564 meta-address (vs a plain
 * 0x-address)? Used by the facilitator to decide which path to take.
 */
export function isStealthMetaAddress(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.startsWith("st:")) return true;
  // bare 0x form is allowed: 132 hex chars + 0x prefix
  if (s.startsWith("0x") && s.length === 134 && /^0x[0-9a-fA-F]+$/.test(s)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Facilitator-side: per-payment stealth derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a fresh stealth address for a provider, given their meta-address
 * and a 32-byte ephemeral nonce (= ephemeral private key r).
 *
 * The facilitator publishes `ephemeralPublicKey` on-chain alongside the
 * payment; the provider scans for it and recovers the funds. The nonce
 * MUST be unpredictable to anyone but the facilitator and MUST NOT repeat
 * (a repeat collapses two payments to the same stealth address, leaking
 * the link). Pass `undefined` to generate a fresh CSPRNG nonce.
 *
 * @param metaAddress provider's "st:base:0x..." meta-address
 * @param ephemeralNonce 32-byte scalar, or undefined for fresh randomness
 */
export function deriveStealthAddress(
  metaAddress: string,
  ephemeralNonce?: Uint8Array,
): DerivedStealthAddress {
  const { spendingPublicKey, viewingPublicKey } = parseMetaAddress(metaAddress);

  // F8: the stealth private key the recipient later derives is
  //   k = (k_s + keccak256(r·K_v)) mod n
  // and is UNSPENDABLE if it lands on 0. Pre-fix, the sender announced the
  // ephemeral key R first and only the recipient discovered the doomed key —
  // funds permanently stuck. Here, on the sender side, we detect the degenerate
  // case (the derived stealth POINT being the curve identity, which is exactly
  // when k ≡ 0) BEFORE returning anything to announce. With a random nonce we
  // simply redraw; with a caller-supplied nonce we throw so the caller picks
  // another. The event is ~1-in-2^256, so this never loops in practice.
  const PP = (secp256k1 as unknown as { ProjectivePoint: ProjectivePointApi })
    .ProjectivePoint;
  const n = (secp256k1 as unknown as { CURVE: { n: bigint } }).CURVE.n;

  for (let attempt = 0; ; attempt++) {
    const r =
      attempt === 0 && ephemeralNonce
        ? clampToCurve(ephemeralNonce)
        : secp256k1.utils.randomPrivateKey();
    if (r.length !== 32) {
      throw new Error(`stealth: ephemeralNonce must be 32 bytes, got ${r.length}`);
    }

    const ephemeralPublicKey = secp256k1.getPublicKey(r, true);

    // S = r · K_v, compressed (33B). Hash with keccak256 per scheme 1.
    const sharedPointCompressed = secp256k1.getSharedSecret(r, viewingPublicKey);
    const sharedSecretHash = keccak_256(sharedPointCompressed);

    // Necessary condition: the additive scalar must be non-zero mod n.
    const sScalar = bytesToBigInt(sharedSecretHash) % n;
    let degenerate = sScalar === 0n;
    let stealthAddress = "";
    if (!degenerate) {
      try {
        // Throws if the resulting point is the identity (k ≡ 0) — the exact
        // unspendable case we must avoid announcing.
        const hashedPoint = PP.BASE.multiply(sScalar);
        const stealthPoint = PP.fromHex(spendingPublicKey).add(hashedPoint);
        const uncompressed = stealthPoint.toRawBytes(false);
        const addressBytes = keccak_256(uncompressed.slice(1)).slice(12);
        stealthAddress = "0x" + bytesToHex(addressBytes);
      } catch {
        degenerate = true;
      }
    }

    if (degenerate) {
      if (ephemeralNonce && attempt === 0) {
        throw new Error(
          "stealth: supplied ephemeralNonce yields an unspendable (zero) stealth key — pick another",
        );
      }
      continue; // random path: redraw (astronomically rare)
    }

    const viewTag = bytesToHex(sharedSecretHash.slice(0, 1));
    return {
      stealthAddress,
      ephemeralPublicKey: "0x" + bytesToHex(ephemeralPublicKey),
      viewTag: "0x" + viewTag,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-side: scanning + private-key recovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given the provider's viewing private key and a batch of recent ephemeral
 * pubkeys (from on-chain Announcement events or facilitator settle logs),
 * return the stealth addresses that belong to this provider.
 *
 * View-tag optimization: if `expectedViewTags` is supplied, each candidate
 * is filtered on its 1-byte view tag before the (more expensive) point add.
 * This reduces scan cost by ~256× when most announcements aren't ours.
 *
 * @param viewingPrivateKey provider's viewing private key (32 bytes or hex)
 * @param recentEphemeralPubkeys array of compressed ephemeral pubkeys
 * @param spendingPublicKey provider's spending public key (needed to derive
 *        the stealth address from the shared secret)
 * @param expectedViewTags optional array (same length as recentEphemeralPubkeys);
 *        if a tag is provided and doesn't match, the entry is skipped without
 *        doing the point arithmetic
 */
export function scanForPayments(
  viewingPrivateKey: Uint8Array | string,
  recentEphemeralPubkeys: Array<Uint8Array | string>,
  spendingPublicKey: Uint8Array | string,
  expectedViewTags?: Array<Uint8Array | string | undefined>,
): ScanMatch[] {
  const kv = toBytes32(viewingPrivateKey);
  const Ks = toCompressedPubKey(spendingPublicKey);

  const matches: ScanMatch[] = [];
  for (let i = 0; i < recentEphemeralPubkeys.length; i++) {
    const R = toCompressedPubKey(recentEphemeralPubkeys[i]);

    // S = k_v · R, hashed.
    const sharedPointCompressed = secp256k1.getSharedSecret(kv, R);
    const sharedSecretHash = keccak_256(sharedPointCompressed);
    const observedTag = sharedSecretHash[0];

    // View-tag pre-filter: skip the point add if the tag is provided and mismatches.
    if (expectedViewTags && expectedViewTags[i] !== undefined) {
      const expected = parseViewTagByte(expectedViewTags[i]!);
      if (expected !== observedTag) continue;
    }

    const stealthAddress = stealthAddressFromHashed(Ks, sharedSecretHash);

    matches.push({
      index: i,
      ephemeralPublicKey: "0x" + bytesToHex(R),
      stealthAddress,
      viewTag: "0x" + bytesToHex(Uint8Array.of(observedTag)),
    });
  }
  return matches;
}

/**
 * Given the provider's spending+viewing private keys and an ephemeral pubkey
 * that's known to belong to this provider, derive the stealth address's
 * private key. With this key the provider can sweep funds to a treasury.
 *
 *   k_stealth = (k_s + keccak256(k_v · R)) mod n
 *
 * @returns 32-byte stealth private key (raw bytes; 0x-encode if you need hex)
 */
export function computeStealthPrivateKey(
  spendingPrivateKey: Uint8Array | string,
  viewingPrivateKey: Uint8Array | string,
  ephemeralPublicKey: Uint8Array | string,
): Uint8Array {
  const ks = toBytes32(spendingPrivateKey);
  const kv = toBytes32(viewingPrivateKey);
  const R = toCompressedPubKey(ephemeralPublicKey);

  const sharedPointCompressed = secp256k1.getSharedSecret(kv, R);
  const sharedSecretHash = keccak_256(sharedPointCompressed);

  // Field is the curve's scalar order n.
  const n = (secp256k1 as unknown as { CURVE: { n: bigint } }).CURVE.n;
  const sum = (bytesToBigInt(ks) + bytesToBigInt(sharedSecretHash)) % n;
  if (sum === 0n) {
    // 1-in-2^256 event; refuse rather than emit the zero key.
    throw new Error("stealth: derived stealth private key is zero (refusing)");
  }
  return bigIntToBytes32(sum);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/** P = K_s + s_h · G   →   address = keccak256(uncompressed(P)[1:])[-20:] */
function stealthAddressFromHashed(
  spendingPubKeyCompressed: Uint8Array,
  sharedSecretHash: Uint8Array,
): string {
  // ProjectivePoint is exposed on @noble/curves secp256k1 for back-compat.
  const PP = (secp256k1 as unknown as { ProjectivePoint: ProjectivePointApi })
    .ProjectivePoint;
  const hashedPoint = PP.BASE.multiply(bytesToBigInt(sharedSecretHash));
  const spendingPoint = PP.fromHex(spendingPubKeyCompressed);
  const stealthPoint = spendingPoint.add(hashedPoint);
  const uncompressed = stealthPoint.toRawBytes(false); // 65 bytes, 0x04 || X || Y
  const addressBytes = keccak_256(uncompressed.slice(1)).slice(12);
  return "0x" + bytesToHex(addressBytes);
}

interface ProjectivePointApi {
  BASE: {
    multiply(scalar: bigint): {
      add(other: unknown): { toRawBytes(compressed: boolean): Uint8Array };
    };
  };
  fromHex(input: Uint8Array | string): {
    add(other: unknown): { toRawBytes(compressed: boolean): Uint8Array };
  };
}

function clampToCurve(scalar: Uint8Array): Uint8Array {
  if (scalar.length !== 32) {
    throw new Error(`stealth: scalar must be 32 bytes (got ${scalar.length})`);
  }
  const n = (secp256k1 as unknown as { CURVE: { n: bigint } }).CURVE.n;
  let v = bytesToBigInt(scalar) % n;
  if (v === 0n) v = 1n; // never emit the zero scalar
  return bigIntToBytes32(v);
}

function isValidCompressedPubKey(bytes: Uint8Array): boolean {
  if (bytes.length !== 33) return false;
  if (bytes[0] !== 0x02 && bytes[0] !== 0x03) return false;
  try {
    const PP = (secp256k1 as unknown as { ProjectivePoint: ProjectivePointApi })
      .ProjectivePoint;
    PP.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function toBytes32(input: Uint8Array | string): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) throw new Error(`stealth: expected 32 bytes, got ${input.length}`);
    return input;
  }
  let s = input.startsWith("0x") ? input.slice(2) : input;
  if (s.length !== 64) throw new Error(`stealth: expected 32-byte hex, got ${s.length / 2} bytes`);
  return hexToBytes(s);
}

function toCompressedPubKey(input: Uint8Array | string): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 33) return input;
    if (input.length === 65) {
      // Re-compress: just take parity bit + X.
      const PP = (secp256k1 as unknown as { ProjectivePoint: ProjectivePointApi })
        .ProjectivePoint;
      return (PP.fromHex(input) as unknown as { toRawBytes(c: boolean): Uint8Array }).toRawBytes(true);
    }
    throw new Error(`stealth: pubkey must be 33B (compressed) or 65B (uncompressed), got ${input.length}`);
  }
  let s = input.startsWith("0x") ? input.slice(2) : input;
  if (s.length !== 66 && s.length !== 130) {
    throw new Error(`stealth: pubkey hex must be 66 or 130 chars, got ${s.length}`);
  }
  return toCompressedPubKey(hexToBytes(s));
}

function parseViewTagByte(input: Uint8Array | string): number {
  if (input instanceof Uint8Array) {
    if (input.length === 0) throw new Error("stealth: empty view tag");
    return input[0];
  }
  let s = input.startsWith("0x") ? input.slice(2) : input;
  if (s.length < 2) throw new Error(`stealth: view tag too short: ${input}`);
  return parseInt(s.slice(0, 2), 16);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new Error("stealth: odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntToBytes32(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("stealth: negative scalar");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("stealth: scalar > 2^256");
  return out;
}
