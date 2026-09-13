/**
 * Pinning tests for `@zbase-protocol/core` Phase 1B HD viewing keys.
 *
 * Failure modes guarded:
 *
 *  1. Drift in the BIP44 path. If the path changes silently, every existing
 *     wallet's recovery returns a different key — funds aren't lost but
 *     localStorage and on-chain notes stop linking up.
 *  2. Non-determinism. Same mnemonic + same index must give the same key
 *     across machines, runtimes, and process restarts. Otherwise recovery
 *     is broken by definition.
 *  3. Encrypt/decrypt round-trip across an HD-derived key. The whole point
 *     of HD viewing keys is that they slot into existing notes.ts crypto
 *     unchanged.
 *
 * Run:
 *   from packages/core: `npx tsx src/viewingKeyHD.test.ts`
 */

import * as assert from "node:assert/strict";
import {
  deriveViewingKeyFromMnemonic,
  deriveViewingKeyFromSeed,
  generateNewMnemonic,
  exportMnemonic,
  mnemonicFromEntropy,
  isValidMnemonic,
  ZBASE_VIEWING_KEY_PATH_PREFIX,
} from "./viewingKeyHD.js";
import {
  createNote,
  encryptNoteForTransfer,
  decryptNoteWithAAD,
  commitmentOf,
} from "./notes.js";

// Stable mnemonic + 16-byte entropy for cross-run determinism. Generated once
// via mnemonicFromEntropy(Uint8Array(16).fill(0x11)). Do NOT regenerate.
const FIXED_MNEMONIC =
  mnemonicFromEntropy(new Uint8Array(16).fill(0x11));

// 1. Path prefix is locked.
{
  assert.equal(
    ZBASE_VIEWING_KEY_PATH_PREFIX,
    "m/44'/60'/0'/0'",
    "BIP44 path prefix is part of the wallet API — DO NOT change without a migration plan",
  );
}

// 2. Determinism: same mnemonic + same index → identical key bytes.
{
  const a = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  const b = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  assert.deepEqual(a.privateKey, b.privateKey, "private key must be deterministic");
  assert.deepEqual(a.publicKey, b.publicKey, "public key must be deterministic");
  assert.equal(a.derivationPath, "m/44'/60'/0'/0'/0");
  assert.equal(a.index, 0);
  assert.equal(a.mnemonic, FIXED_MNEMONIC);
}

// 3. Different index → different key.
{
  const a = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  const b = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 1);
  assert.notDeepEqual(
    a.privateKey,
    b.privateKey,
    "different index must produce different private key",
  );
  assert.notDeepEqual(
    a.publicKey,
    b.publicKey,
    "different index must produce different public key",
  );
}

// 4. Different mnemonic → different key (overwhelming probability).
{
  const a = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  const otherMnemonic = mnemonicFromEntropy(new Uint8Array(16).fill(0x22));
  assert.notEqual(otherMnemonic, FIXED_MNEMONIC, "test entropy values must differ");
  const b = deriveViewingKeyFromMnemonic(otherMnemonic, 0);
  assert.notDeepEqual(a.privateKey, b.privateKey, "different mnemonic must change key");
}

// 5. Invalid mnemonics are rejected.
{
  assert.throws(
    () => deriveViewingKeyFromMnemonic("not a real mnemonic", 0),
    /invalid BIP39 mnemonic/,
    "must reject non-wordlist input",
  );
  assert.throws(
    () => deriveViewingKeyFromMnemonic("abandon abandon abandon", 0),
    /invalid BIP39 mnemonic/,
    "must reject short input",
  );
}

// 6. Negative / fractional index is rejected.
{
  assert.throws(
    () => deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, -1),
    /non-negative integer/,
    "negative index must throw",
  );
  assert.throws(
    () => deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 1.5),
    /non-negative integer/,
    "fractional index must throw",
  );
}

// 7. Seed-derived path produces a valid key (no mnemonic, but path + bytes set).
{
  const seed = new Uint8Array(64);
  for (let i = 0; i < seed.length; i++) seed[i] = i & 0xff;
  const k = deriveViewingKeyFromSeed(seed, 0);
  assert.equal(k.privateKey.length, 32);
  assert.equal(k.publicKey.length, 32);
  assert.equal(k.mnemonic, undefined, "seed-derived key has no mnemonic");
  assert.equal(k.derivationPath, "m/44'/60'/0'/0'/0");

  // Determinism across a second call.
  const k2 = deriveViewingKeyFromSeed(seed, 0);
  assert.deepEqual(k.privateKey, k2.privateKey);
}

// 8. Seed shorter than 32 bytes is rejected (refuse low-entropy keys).
{
  assert.throws(
    () => deriveViewingKeyFromSeed(new Uint8Array(16), 0),
    /must be ≥ 32 bytes/,
    "low-entropy seed must throw",
  );
}

// 9. exportMnemonic recovers the original mnemonic round-trip.
{
  const k = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  assert.equal(
    exportMnemonic(k),
    FIXED_MNEMONIC,
    "mnemonic must round-trip through ViewingKey.mnemonic",
  );

  const seedDerived = deriveViewingKeyFromSeed(new Uint8Array(64), 0);
  assert.equal(exportMnemonic(seedDerived), undefined);
}

// 10. End-to-end: HD-derived viewing key works with encryptNoteForTransfer +
//     decryptNoteWithAAD. This is the integration contract Phase 1B promises.
{
  const recipient = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  const note = createNote(1_000_000n, 42n); // $1, ASP label 42
  const commitment = commitmentOf(note);
  const blob = encryptNoteForTransfer(note, recipient.publicKey, commitment);
  const decrypted = decryptNoteWithAAD(blob, recipient.privateKey, commitment);
  assert.ok(decrypted, "HD viewing key must decrypt its own transfer ciphertext");
  assert.equal(decrypted.amount, note.amount);
  assert.equal(decrypted.label, note.label);
  assert.equal(decrypted.nullifier, note.nullifier);
  assert.equal(decrypted.secret, note.secret);
}

// 11. A different HD index cannot decrypt the wrong recipient's note.
{
  const receiver = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 0);
  const stranger = deriveViewingKeyFromMnemonic(FIXED_MNEMONIC, 99);
  const note = createNote(500_000n, 7n);
  const c = commitmentOf(note);
  const blob = encryptNoteForTransfer(note, receiver.publicKey, c);
  assert.equal(
    decryptNoteWithAAD(blob, stranger.privateKey, c),
    null,
    "wrong HD index must NOT decrypt",
  );
}

// 12. generateNewMnemonic produces a valid 12-word mnemonic by default.
{
  const m = generateNewMnemonic();
  assert.equal(m.split(/\s+/).length, 12, "default strength → 12 words");
  assert.ok(isValidMnemonic(m), "self-generated mnemonic must validate");
}

// 13. generateNewMnemonic at 256 bits → 24 words.
{
  const m = generateNewMnemonic(256);
  assert.equal(m.split(/\s+/).length, 24, "256-bit strength → 24 words");
  assert.ok(isValidMnemonic(m));
}

console.log("zbase/core viewingKeyHD.test.ts: HD derivation invariants hold");
