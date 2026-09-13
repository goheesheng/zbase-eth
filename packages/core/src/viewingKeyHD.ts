/**
 * @zbase-protocol/core — BIP32 HD derivation for viewing keys (Phase 1B)
 *
 * Replaces the per-session random viewing keys produced by
 * `generateViewingKey()` in `notes.ts` with a deterministic HD scheme rooted
 * in a BIP39 mnemonic. The mnemonic IS the recovery secret: if a user clears
 * localStorage but kept the 12/24-word phrase, they can re-derive every
 * viewing key and rescan the chain to rebuild their note set.
 *
 * Derivation path:    m/44'/60'/0'/0'/<index>
 *  - 44'  BIP44
 *  - 60'  coin_type = Ethereum (matches the on-chain UTXOPool domain)
 *  - 0'   account
 *  - 0    external chain
 *  - i    index (0 for primary viewing key; supports per-app sub-keys later)
 *
 * Output: an X25519 keypair compatible with `encryptNote` / `decryptNote` in
 * notes.ts. The X25519 private key is taken as the SHA-512 hash of the BIP32
 * private key (NOT the BIP32 key itself — different curves; X25519 clamps
 * scalars). The first 32 bytes of the SHA-512 are used; the remaining 32 are
 * discarded. This matches the X25519 key-generation recipe in RFC 7748 §5
 * which mandates clamping but accepts any uniformly-distributed 32-byte seed.
 *
 * NOTE: `@scure/bip32` and `@scure/bip39` are added as direct dependencies of
 * @zbase-protocol/core in Phase 1B because they are needed for recovery.
 */

import { HDKey } from "@scure/bip32";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
  entropyToMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { x25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import type { ViewingKeyPair } from "./notes.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * BIP44 path prefix used by zBase viewing keys. The trailing index is
 * appended by the derivation helpers below.
 *
 *   m / 44' / 60' / 0' / 0' / index
 *
 * The fourth segment is hardened (`0'`) — diverging from the canonical
 * Ethereum address path (`m/44'/60'/0'/0/index`) — so a leaked viewing key
 * (which is intentionally read-only) cannot be combined with a sibling
 * Ethereum address public key to attempt key recovery.
 */
export const ZBASE_VIEWING_KEY_PATH_PREFIX = "m/44'/60'/0'/0'";

/**
 * Default mnemonic strength: 128 bits = 12 words. Matches MetaMask /
 * Rabby / most consumer wallets. 256-bit (24-word) generation is supported
 * via `generateNewMnemonic(256)`.
 */
export const DEFAULT_MNEMONIC_STRENGTH_BITS = 128;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * HD-derived viewing key. Adds `mnemonic` + `derivationPath` provenance on top
 * of the bare X25519 keypair so the wallet UI can show the user which path
 * a key came from, and so the recovery flow can confirm the mnemonic is the
 * one that generated a given on-chain key before re-importing.
 */
export interface ViewingKey extends ViewingKeyPair {
  /** Mnemonic that generated this key. Undefined for seed-derived keys. */
  mnemonic?: string;
  /** Full BIP32 path, e.g., "m/44'/60'/0'/0'/0". */
  derivationPath: string;
  /** Index appended to the path prefix. */
  index: number;
}

// -----------------------------------------------------------------------------
// Generation
// -----------------------------------------------------------------------------

/**
 * Generate a fresh BIP39 mnemonic suitable for viewing-key derivation.
 *
 * `strengthBits` must be a multiple of 32 in [128, 256]:
 *   128 → 12 words (default)
 *   160 → 15 words
 *   192 → 18 words
 *   224 → 21 words
 *   256 → 24 words
 */
export function generateNewMnemonic(
  strengthBits: number = DEFAULT_MNEMONIC_STRENGTH_BITS,
): string {
  return generateMnemonic(wordlist, strengthBits);
}

// -----------------------------------------------------------------------------
// Derivation
// -----------------------------------------------------------------------------

function pathFor(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `deriveViewingKey: index must be a non-negative integer, got ${index}`,
    );
  }
  return `${ZBASE_VIEWING_KEY_PATH_PREFIX}/${index}`;
}

/**
 * Convert a 32-byte BIP32 private key into an X25519 keypair.
 *
 * The BIP32 key is on the secp256k1 curve; X25519 expects a 32-byte scalar
 * that will be clamped to Curve25519. We hash the BIP32 key with SHA-512 and
 * take the first 32 bytes — this preserves uniform distribution and never
 * exposes the secp256k1 scalar directly (so the same mnemonic can sign EVM
 * txs *and* serve as a viewing-key source without one compromising the other).
 */
/**
 * Domain-separation tag (audit F10). Prefixing the SHA-512 input ensures this
 * X25519 viewing-key derivation can never collide with any other SHA-512 use of
 * the same BIP32 key — an attacker who learns one derived value cannot re-hash
 * to confirm or correlate it without also knowing this exact label.
 *
 * NOTE: changing this tag changes ALL derived viewing keys. Safe to set now
 * (UTXO/viewing-key path is pre-mainnet, no production keys exist yet); MUST be
 * frozen before any mainnet viewing key is derived, or recovery breaks.
 */
const X25519_VIEWING_KEY_DST = new TextEncoder().encode(
  "zBase/viewing-key/x25519/v1",
);

function bip32PrivToX25519(bip32PrivateKey: Uint8Array): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const domainSeparated = new Uint8Array(
    X25519_VIEWING_KEY_DST.length + bip32PrivateKey.length,
  );
  domainSeparated.set(X25519_VIEWING_KEY_DST, 0);
  domainSeparated.set(bip32PrivateKey, X25519_VIEWING_KEY_DST.length);
  const seed = sha512(domainSeparated).slice(0, 32);
  const privateKey = new Uint8Array(seed); // copy so we own the bytes
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Derive a viewing key from a BIP39 mnemonic at the given index.
 *
 * The same mnemonic + same index always produces the same viewing key, which
 * is exactly what makes recovery possible: re-running this with the user's
 * 12 words reproduces every viewing-key the wallet has ever used.
 *
 * @throws if `mnemonic` does not validate against the BIP39 English wordlist.
 */
export function deriveViewingKeyFromMnemonic(
  mnemonic: string,
  index = 0,
): ViewingKey {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("deriveViewingKeyFromMnemonic: invalid BIP39 mnemonic");
  }
  const seed = mnemonicToSeedSync(mnemonic);
  const derivationPath = pathFor(index);
  const node = HDKey.fromMasterSeed(seed).derive(derivationPath);
  if (!node.privateKey) {
    throw new Error(
      `deriveViewingKeyFromMnemonic: HDKey at ${derivationPath} has no private key`,
    );
  }
  const { privateKey, publicKey } = bip32PrivToX25519(node.privateKey);
  return { privateKey, publicKey, mnemonic, derivationPath, index };
}

/**
 * Derive a viewing key from a raw seed (32+ bytes, typically the 64-byte
 * BIP39 seed but any high-entropy bytes will do). Useful when the wallet has
 * already stretched the mnemonic with a passphrase and wants to keep the
 * passphrase out of the call site.
 *
 * The mnemonic field on the returned ViewingKey will be `undefined`.
 */
export function deriveViewingKeyFromSeed(
  seed: Uint8Array,
  index = 0,
): ViewingKey {
  // HIGH fix (SDK audit 2026-07-09): require EXACTLY the 64-byte BIP39 seed
  // (`mnemonicToSeedSync(mnemonic)`). The prior `>= 32` check let a caller pass
  // 32-byte entropy (or any 32+ bytes) that derives a DIFFERENT viewing key than
  // the mnemonic path — so a wallet "recovering" from the wrong-length seed scans
  // the chain, finds none of its own notes, and concludes funds are lost. Only
  // the 64-byte BIP39 seed matches deriveViewingKeyFromMnemonic. Enforce it.
  if (seed.length !== 64) {
    throw new Error(
      `deriveViewingKeyFromSeed: seed must be the 64-byte BIP39 seed (output of ` +
        `mnemonicToSeedSync), got ${seed.length} bytes. Passing raw entropy or a ` +
        `different length derives a DIFFERENT key than the mnemonic path and ` +
        `breaks note recovery. Use deriveViewingKeyFromMnemonic if you have the phrase.`,
    );
  }
  const derivationPath = pathFor(index);
  const node = HDKey.fromMasterSeed(seed).derive(derivationPath);
  if (!node.privateKey) {
    throw new Error(
      `deriveViewingKeyFromSeed: HDKey at ${derivationPath} has no private key`,
    );
  }
  const { privateKey, publicKey } = bip32PrivToX25519(node.privateKey);
  return { privateKey, publicKey, derivationPath, index };
}

// -----------------------------------------------------------------------------
// Recovery helpers
// -----------------------------------------------------------------------------

/**
 * Return the mnemonic that produced the given viewing key. Returns
 * `undefined` for seed-derived keys (the seed-derivation path is one-way).
 *
 * UI flow: present this to the user during "Show recovery phrase". Never log
 * it; never persist it beyond the wallet's seed-vault component.
 */
export function exportMnemonic(viewingKey: ViewingKey): string | undefined {
  return viewingKey.mnemonic;
}

/**
 * Round-trip a raw entropy buffer (16 / 20 / 24 / 28 / 32 bytes) to its BIP39
 * mnemonic. Useful for tests and for wallets that want to derive the mnemonic
 * from a hardware-generated entropy source.
 */
export function mnemonicFromEntropy(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

/**
 * Validate a BIP39 mnemonic against the English wordlist. Returns false for
 * checksum failures, non-wordlist words, and wrong word counts.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}
