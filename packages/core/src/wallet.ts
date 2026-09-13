/**
 * @zbase-protocol/core/wallet — the BROWSER-SAFE wallet surface.
 *
 * Why this subpath exists: the main entry re-exports proofs.ts, which pulls snarkjs
 * and therefore `node:module`. Importing "@zbase-protocol/core" from a client
 * component fails the bundle outright — "the chunking context does not support
 * external modules (request: node:module)". Everything re-exported here depends only
 * on @scure / @noble / poseidon-lite, so it bundles for a browser.
 *
 * (Not named `notes` — notes.ts is already the UTXO primitives, and that surface is
 * quarantined behind /experimental for a live wire-format break.)
 *
 * This is what a wallet needs on the client:
 *   - generate / validate a BIP39 seed
 *   - derive a note from (seed, index)         → deposits that are RE-DERIVABLE
 *   - recover notes from (seed, chain events)  → a wiped device rebuilds its balance
 *
 * It matters because a note's nullifier/secret ARE the money, handed over exactly
 * once: drop them and the funds are locked in the pool forever — no ragequit, no
 * re-derivation (0.985 USDC, 2026-07-16). Derivation turns permanent loss into a
 * re-scan.
 *
 * Server code should keep importing "@zbase-protocol/core" — it needs the proofs.
 */

// Seed management.
export type { ViewingKey } from "./viewingKeyHD.js";
export {
  generateNewMnemonic,
  isValidMnemonic,
  mnemonicFromEntropy,
  exportMnemonic,
  ZBASE_VIEWING_KEY_PATH_PREFIX,
} from "./viewingKeyHD.js";

// Seed → note, and seed + chain → notes.
export type { ForwardingNoteSecrets } from "./forwardingNotes.js";
export {
  deriveForwardingNote,
  precommitmentForRelayer,
  recoverForwardingNotes,
  ZBASE_FORWARDING_PATH_PREFIX,
} from "./forwardingNotes.js";

// Circuit primitives (pure Poseidon/keccak — no snarkjs).
export {
  computePrecommitment,
  computeCommitment,
  computeNullifierHash,
  computeLabel,
  SNARK_SCALAR_FIELD,
} from "./account.js";

// Balance from a seed. Composes the above; no proving, so browser-safe.
export type { WalletBalance, WalletNote, RecoveredNote, IsNullifierSpent } from "./walletBalance.js";
export { getWalletBalance, selectNote } from "./walletBalance.js";
