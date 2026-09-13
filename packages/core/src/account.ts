/**
 * @zbase-protocol/core — Chain-agnostic account management
 *
 * Hashing matches the upstream Privacy Pools circom circuit exactly:
 *   * `precommitment = Poseidon(2)([nullifier, secret])`
 *   * `commitment    = Poseidon(3)([value, label, precommitment])`
 *   * `nullifierHash = Poseidon(1)([nullifier])`
 *   * `label         = keccak256(scope || nonce_be32) % SNARK_SCALAR_FIELD`
 * See packages/circuits/circuits/commitment.circom in the 0xbow/privacy-pools-core
 * repo for ground truth. Any deviation here breaks proof verification.
 */

import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3";
import type { AccountSecrets, ZX402AccountData, ChainType } from "./types.js";

export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Generate a fresh nullifier + secret.
 * The full commitment depends on `value` and `label`, both of which only
 * become known at deposit time — so this returns just the secrets.
 */
export function generateDepositSecrets(): {
  nullifier: string;
  secret: string;
} {
  return {
    nullifier: randomFieldElement().toString(),
    secret: randomFieldElement().toString(),
  };
}

/**
 * `precommitment = Poseidon(2)([nullifier, secret])`.
 * Sent to the on-chain `deposit` instruction. The pool then computes
 * `commitment = Poseidon(3)([value, label, precommitment])` itself, so the
 * depositor cannot lie about which value/label their commitment claims.
 */
export function computePrecommitment(
  nullifier: string,
  secret: string,
): string {
  return poseidon2([BigInt(nullifier), BigInt(secret)]).toString();
}

/**
 * `commitment = Poseidon(3)([value, label, precommitment])`. Mirrors the
 * `CommitmentHasher` template in `commitment.circom`.
 */
export function computeCommitment(
  value: string | bigint,
  label: string | bigint,
  precommitment: string | bigint,
): string {
  return poseidon3([BigInt(value), BigInt(label), BigInt(precommitment)]).toString();
}

/**
 * `nullifierHash = Poseidon(1)([nullifier])`. Used as the spend marker
 * on-chain (and as PDA seed on Solana). Output is the second public signal
 * of the withdraw circuit.
 */
export function computeNullifierHash(nullifier: string | bigint): string {
  return poseidon1([BigInt(nullifier)]).toString();
}

/**
 * `label = keccak256(scope || nonce_be32) % SNARK_SCALAR_FIELD`. Mirrors the
 * EVM pool's on-chain label derivation and the SVM program's
 * `crypto::compute_label`. Both `scope` and `nonce` are encoded as 32-byte
 * big-endian values to match the on-chain Solana implementation.
 */
export function computeLabel(scope: string | bigint, nonce: number | bigint): string {
  const buf = new Uint8Array(32 + 8);
  feToBE32(BigInt(scope)).forEach((b, i) => (buf[i] = b));
  // 8 bytes big-endian nonce
  let n = BigInt(nonce);
  for (let i = 7; i >= 0; i--) {
    buf[32 + i] = Number(n & 0xffn);
    n >>= 8n;
  }
  const h = keccak_256(buf);
  let x = 0n;
  for (const b of h) x = (x << 8n) | BigInt(b);
  return (x % SNARK_SCALAR_FIELD).toString();
}

/**
 * Encode a field element as 32-byte big-endian. Required by the on-chain
 * Solana program (and by `groth16-solana` for proof public inputs).
 */
export function feToBE32(value: string | bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = BigInt(value);
  if (v < 0n) throw new Error("feToBE32: negative");
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("feToBE32: value > 2^256");
  return out;
}

/**
 * Create a full account from secrets + on-chain data.
 */
export function createAccount(
  secrets: AccountSecrets,
  chain: ChainType,
  depositTxHash?: string
): ZX402AccountData {
  return {
    secrets,
    depositTxHash,
    chain,
    withdrawn: false,
    createdAt: Date.now(),
  };
}

/**
 * Serialize account to JSON for storage.
 */
export function serializeAccount(account: ZX402AccountData): string {
  return JSON.stringify(account);
}

/**
 * Deserialize account from JSON.
 */
export function deserializeAccount(json: string): ZX402AccountData {
  return JSON.parse(json) as ZX402AccountData;
}

/**
 * Generate a uniformly-random field element in the BN254/BN128 scalar field,
 * via REJECTION SAMPLING (audit F7).
 *
 * The naive `random256() % SNARK_SCALAR_FIELD` is biased: 2^256 is not a
 * multiple of the field order, so the lowest values in [0, 2^256 mod r) are
 * slightly more likely. For per-note `nullifier`/`secret` values that bias is a
 * small but real statistical weakness. Rejection sampling — redraw whenever the
 * 256-bit sample is >= the largest multiple of r below 2^256 — yields an exactly
 * uniform result. The reject probability is < ~6e-39 per draw (r is ~2^253.6),
 * so this terminates in one iteration in practice.
 *
 * Uses `crypto.getRandomValues` (CSPRNG), never Math.random.
 */
export function randomFieldElement(): bigint {
  // Largest multiple of r that fits in 256 bits; samples >= this are rejected.
  const TWO_256 = 1n << 256n;
  const limit = TWO_256 - (TWO_256 % SNARK_SCALAR_FIELD);
  const bytes = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(bytes);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < limit) return value % SNARK_SCALAR_FIELD;
    // else: in the biased tail — redraw (astronomically rare).
  }
}
